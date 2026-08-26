package runadmission

import (
	"context"
	"errors"
	"sync"

	"github.com/google/uuid"
)

const (
	maxPoolWorkers   = 128
	maxPoolQueueSize = 100000
)

// Pool is a bounded in-process worker queue tied to a caller-owned context.
//
// It is the execution substrate of the in-process configuration: run
// dispatch uses one for issue runs and workflow execution another, so the
// queueing, shutdown and back-pressure rules exist once. Work queued here
// does not survive the process; that is the documented trade-off of running
// without Temporal, not a defect of the pool.
type Pool struct {
	ctx       context.Context
	cancel    context.CancelFunc
	fn        func(context.Context, uuid.UUID)
	jobs      chan uuid.UUID
	wg        sync.WaitGroup
	done      chan struct{}
	closeOnce sync.Once
}

// NewPool starts workers that call fn with the pool's context for every
// queued id. Close, or cancellation of parent, ends every worker; fn is
// expected to honour the context it receives.
func NewPool(
	parent context.Context,
	workers, queueSize int,
	fn func(context.Context, uuid.UUID),
) (*Pool, error) {
	if parent == nil {
		return nil, errors.New("worker pool context is nil")
	}
	if fn == nil {
		return nil, errors.New("worker pool function is nil")
	}
	if workers == 0 {
		workers = defaultWorkers
	}
	if queueSize == 0 {
		queueSize = defaultQueueSize
	}
	if workers < 1 || workers > maxPoolWorkers {
		return nil, errors.New("worker pool worker count is invalid")
	}
	if queueSize < 1 || queueSize > maxPoolQueueSize {
		return nil, errors.New("worker pool queue size is invalid")
	}
	ctx, cancel := context.WithCancel(parent)
	pool := &Pool{
		ctx:    ctx,
		cancel: cancel,
		fn:     fn,
		jobs:   make(chan uuid.UUID, queueSize),
		done:   make(chan struct{}),
	}
	for range workers {
		pool.wg.Add(1)
		go pool.worker()
	}
	go func() {
		pool.wg.Wait()
		close(pool.done)
	}()
	return pool, nil
}

// Queue hands one id to the workers. It blocks while the queue is full and
// refuses once the pool is shutting down.
func (pool *Pool) Queue(id uuid.UUID) error {
	if pool == nil {
		return errors.New("worker pool is not configured")
	}
	// Checked before the select: with room in the queue and a cancelled
	// context both cases are ready, and work accepted after Close would
	// never run.
	if pool.ctx.Err() != nil {
		return errors.New("run workers are shutting down")
	}
	select {
	case pool.jobs <- id:
		return nil
	case <-pool.ctx.Done():
		return errors.New("run workers are shutting down")
	}
}

// Context is the pool's lifetime, which every worker call runs under.
func (pool *Pool) Context() context.Context {
	if pool == nil {
		return context.Background()
	}
	return pool.ctx
}

// Close cancels the workers and waits until every in-flight call returns.
func (pool *Pool) Close(ctx context.Context) error {
	if pool == nil {
		return nil
	}
	pool.closeOnce.Do(pool.cancel)
	select {
	case <-pool.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (pool *Pool) worker() {
	defer pool.wg.Done()
	for {
		select {
		case <-pool.ctx.Done():
			return
		case id := <-pool.jobs:
			pool.fn(pool.ctx, id)
		}
	}
}
