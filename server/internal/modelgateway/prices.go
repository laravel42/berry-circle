package modelgateway

import (
	"context"
	"sync"
	"time"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// CatalogPrices prices roles through the model catalog. The catalog is one
// runtime round trip, so the price table is cached: a plan makes several
// calls in a row and none of them should pay for the list twice.
type CatalogPrices struct {
	Catalog openfang.Catalog
	TTL     time.Duration
	Clock   func() time.Time

	mu       sync.Mutex
	table    map[string]Price
	cachedAt time.Time
}

const defaultPriceTTL = 15 * time.Minute

// Price implements PriceLookup.
func (prices *CatalogPrices) Price(ctx context.Context, provider, model string) (Price, bool) {
	if prices == nil || prices.Catalog == nil {
		return Price{}, false
	}
	table := prices.load(ctx)
	price, ok := table[provider+"/"+model]
	return price, ok
}

func (prices *CatalogPrices) load(ctx context.Context) map[string]Price {
	clock := prices.Clock
	if clock == nil {
		clock = time.Now
	}
	ttl := prices.TTL
	if ttl <= 0 {
		ttl = defaultPriceTTL
	}
	prices.mu.Lock()
	defer prices.mu.Unlock()
	if prices.table != nil && clock().Sub(prices.cachedAt) < ttl {
		return prices.table
	}
	models, err := prices.Catalog.ListModelCatalog(ctx)
	if err != nil {
		// Serve what was known; a transient catalog failure must not make a
		// plan's cost disappear from the ledger for the next quarter hour.
		return prices.table
	}
	table := make(map[string]Price, len(models))
	for _, model := range models {
		if model.InputCostPerM == 0 && model.OutputCostPerM == 0 {
			continue
		}
		table[model.Provider+"/"+model.ID] = Price{InputPerMillion: model.InputCostPerM, OutputPerMillion: model.OutputCostPerM}
	}
	prices.table = table
	prices.cachedAt = clock()
	return table
}

var _ PriceLookup = (*CatalogPrices)(nil)
