package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	idempotencyTTL     = 24 * time.Hour
	idempotencyLease   = 2 * time.Minute
	maxReplayBodyBytes = 1024 * 1024
)

// IdempotencyDecision tells a create handler whether to execute or replay.
type IdempotencyDecision int

const (
	IdempotencyProceed IdempotencyDecision = iota
	IdempotencyReplay
	IdempotencyConflict
	IdempotencyInProgress
)

// ActorScope is the complete idempotency namespace.
type ActorScope struct {
	ActorType     string
	ActorID       uuid.UUID
	Method        string
	CanonicalPath string
}

// StoredResponse is the safe replay payload retained for 24 hours.
type StoredResponse struct {
	Status  int
	Headers map[string][]string
	Body    []byte
}

// IdempotencyResult is returned by Store.Begin.
type IdempotencyResult struct {
	Decision IdempotencyDecision
	ClaimID  uuid.UUID
	Response StoredResponse
}

// IdempotencyStore supports actor-scoped claim, replay, and completion.
type IdempotencyStore interface {
	Begin(
		context.Context,
		ActorScope,
		string,
		[32]byte,
		time.Time,
	) (IdempotencyResult, error)
	Complete(context.Context, uuid.UUID, StoredResponse, time.Time) error
	Abandon(context.Context, uuid.UUID) error
}

// PostgresIdempotencyStore persists claims in the authoritative database.
type PostgresIdempotencyStore struct {
	Pool *pgxpool.Pool
}

// ValidateIdempotencyKey enforces the public 16-128 character header contract.
func ValidateIdempotencyKey(key string) error {
	if !utf8.ValidString(key) || len(key) < 16 || len(key) > 128 {
		return errors.New("Idempotency-Key must contain 16 to 128 characters")
	}
	for _, character := range key {
		if character < 0x21 || character > 0x7e {
			return errors.New("Idempotency-Key must contain visible ASCII characters")
		}
	}
	return nil
}

// FingerprintJSON hashes a canonical JSON representation so harmless object
// whitespace and key ordering do not create false conflicts.
func FingerprintJSON(body []byte) ([32]byte, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return [32]byte{}, errors.New("request body is not valid JSON")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return [32]byte{}, errors.New("request body contains multiple JSON values")
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return [32]byte{}, errors.New("canonicalize request body")
	}
	return sha256.Sum256(canonical), nil
}

// Begin atomically claims a key or returns its prior result/conflict.
func (store PostgresIdempotencyStore) Begin(
	ctx context.Context,
	scope ActorScope,
	key string,
	fingerprint [32]byte,
	now time.Time,
) (IdempotencyResult, error) {
	if store.Pool == nil {
		return IdempotencyResult{}, errors.New("idempotency store is unavailable")
	}
	if err := validateScope(scope); err != nil {
		return IdempotencyResult{}, err
	}
	if err := ValidateIdempotencyKey(key); err != nil {
		return IdempotencyResult{}, err
	}
	pathHash := sha256.Sum256([]byte(scope.CanonicalPath))
	tx, err := store.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return IdempotencyResult{}, errors.New("begin idempotency claim")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	if _, err := tx.Exec(
		ctx,
		`DELETE FROM idempotency_records
		 WHERE actor_type = $1 AND actor_id = $2 AND method = $3
		   AND canonical_path_hash = $4 AND idempotency_key = $5
		   AND expires_at <= $6`,
		scope.ActorType,
		scope.ActorID,
		scope.Method,
		pathHash[:],
		key,
		now,
	); err != nil {
		return IdempotencyResult{}, errors.New("expire idempotency claim")
	}

	claimID := uuid.New()
	err = tx.QueryRow(
		ctx,
		`INSERT INTO idempotency_records (
			id, actor_type, actor_id, method, canonical_path,
			canonical_path_hash, idempotency_key, fingerprint,
			lease_expires_at, expires_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 ON CONFLICT DO NOTHING
		 RETURNING id`,
		claimID,
		scope.ActorType,
		scope.ActorID,
		scope.Method,
		scope.CanonicalPath,
		pathHash[:],
		key,
		fingerprint[:],
		now.Add(idempotencyLease),
		now.Add(idempotencyTTL),
	).Scan(&claimID)
	switch {
	case err == nil:
		if err := tx.Commit(ctx); err != nil {
			return IdempotencyResult{}, errors.New("commit idempotency claim")
		}
		return IdempotencyResult{
			Decision: IdempotencyProceed,
			ClaimID:  claimID,
		}, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return IdempotencyResult{}, errors.New("create idempotency claim")
	}

	var (
		existingID     uuid.UUID
		existingPrint  []byte
		status         *int
		headersJSON    []byte
		responseBody   []byte
		leaseExpiresAt time.Time
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT id, fingerprint, response_status,
		        COALESCE(response_headers, '{}'::jsonb), response_body, lease_expires_at
		   FROM idempotency_records
		  WHERE actor_type = $1 AND actor_id = $2 AND method = $3
		    AND canonical_path_hash = $4 AND idempotency_key = $5
		  FOR UPDATE`,
		scope.ActorType,
		scope.ActorID,
		scope.Method,
		pathHash[:],
		key,
	).Scan(
		&existingID,
		&existingPrint,
		&status,
		&headersJSON,
		&responseBody,
		&leaseExpiresAt,
	); err != nil {
		return IdempotencyResult{}, errors.New("read idempotency claim")
	}

	if !bytes.Equal(existingPrint, fingerprint[:]) {
		if err := tx.Commit(ctx); err != nil {
			return IdempotencyResult{}, errors.New("commit idempotency conflict")
		}
		return IdempotencyResult{Decision: IdempotencyConflict}, nil
	}
	if status != nil {
		headers := make(map[string][]string)
		if err := json.Unmarshal(headersJSON, &headers); err != nil {
			return IdempotencyResult{}, errors.New("decode idempotency response")
		}
		if err := tx.Commit(ctx); err != nil {
			return IdempotencyResult{}, errors.New("commit idempotency replay")
		}
		return IdempotencyResult{
			Decision: IdempotencyReplay,
			Response: StoredResponse{
				Status:  *status,
				Headers: headers,
				Body:    responseBody,
			},
		}, nil
	}
	if !leaseExpiresAt.After(now) {
		if _, err := tx.Exec(
			ctx,
			`UPDATE idempotency_records
			    SET lease_expires_at = $2
			  WHERE id = $1`,
			existingID,
			now.Add(idempotencyLease),
		); err != nil {
			return IdempotencyResult{}, errors.New("renew idempotency claim")
		}
		if err := tx.Commit(ctx); err != nil {
			return IdempotencyResult{}, errors.New("commit idempotency claim renewal")
		}
		return IdempotencyResult{
			Decision: IdempotencyProceed,
			ClaimID:  existingID,
		}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return IdempotencyResult{}, errors.New("commit idempotency in-progress result")
	}
	return IdempotencyResult{Decision: IdempotencyInProgress}, nil
}

// Complete stores replayable responses and drops 5xx claims.
func (store PostgresIdempotencyStore) Complete(
	ctx context.Context,
	claimID uuid.UUID,
	response StoredResponse,
	now time.Time,
) error {
	if store.Pool == nil {
		return errors.New("idempotency store is unavailable")
	}
	if response.Status >= 500 {
		return store.Abandon(ctx, claimID)
	}
	if response.Status < 100 || response.Status > 499 {
		return errors.New("idempotency response status is invalid")
	}
	if len(response.Body) > maxReplayBodyBytes {
		return fmt.Errorf("idempotency response exceeds %d bytes", maxReplayBodyBytes)
	}
	headers := replayHeaders(response.Headers)
	encoded, err := json.Marshal(headers)
	if err != nil {
		return errors.New("encode idempotency response headers")
	}
	tag, err := store.Pool.Exec(
		ctx,
		`UPDATE idempotency_records
		    SET response_status = $2,
		        response_headers = $3::jsonb,
		        response_body = $4,
		        completed_at = $5,
		        lease_expires_at = $5,
		        expires_at = $6
		  WHERE id = $1 AND response_status IS NULL`,
		claimID,
		response.Status,
		string(encoded),
		response.Body,
		now,
		now.Add(idempotencyTTL),
	)
	if err != nil {
		return errors.New("complete idempotency claim")
	}
	if tag.RowsAffected() != 1 {
		return errors.New("idempotency claim is no longer active")
	}
	return nil
}

// Abandon removes an incomplete claim so a failed operation can be retried.
func (store PostgresIdempotencyStore) Abandon(
	ctx context.Context,
	claimID uuid.UUID,
) error {
	if store.Pool == nil {
		return errors.New("idempotency store is unavailable")
	}
	if _, err := store.Pool.Exec(
		ctx,
		"DELETE FROM idempotency_records WHERE id = $1 AND response_status IS NULL",
		claimID,
	); err != nil {
		return errors.New("abandon idempotency claim")
	}
	return nil
}

// Replay writes a previously stored response.
func Replay(response http.ResponseWriter, stored StoredResponse) {
	for name, values := range replayHeaders(stored.Headers) {
		for _, value := range values {
			response.Header().Add(name, value)
		}
	}
	response.Header().Set("Idempotency-Replayed", "true")
	response.WriteHeader(stored.Status)
	_, _ = response.Write(stored.Body)
}

func validateScope(scope ActorScope) error {
	if scope.ActorType != "user" && scope.ActorType != "agent" {
		return errors.New("idempotency actor type is invalid")
	}
	if scope.ActorID == uuid.Nil || scope.Method != strings.ToUpper(scope.Method) ||
		scope.Method == "" || len(scope.CanonicalPath) == 0 ||
		len(scope.CanonicalPath) > 2048 ||
		!strings.HasPrefix(scope.CanonicalPath, "/") {
		return errors.New("idempotency scope is invalid")
	}
	return nil
}

func replayHeaders(headers map[string][]string) map[string][]string {
	allowed := map[string]struct{}{
		"Content-Type": {},
		"Location":     {},
		"Etag":         {},
	}
	result := make(map[string][]string)
	for name, values := range headers {
		canonical := http.CanonicalHeaderKey(name)
		if _, ok := allowed[canonical]; !ok {
			continue
		}
		result[canonical] = append([]string(nil), values...)
	}
	return result
}
