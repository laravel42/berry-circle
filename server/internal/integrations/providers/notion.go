package providers

import "github.com/laravel42/berry-circle/server/internal/integrations/core"

// Notion is the native Notion integration.
//
// The tool set follows Notion's current data-source model rather than the older
// database one: a database is a container of data sources, and queries address
// a data source. Building against the deprecated shape would need rewriting the
// first time a workspace used a multi-source database.
type Notion struct{}

func (Notion) ID() string   { return "notion" }
func (Notion) Name() string { return "Notion" }
func (Notion) Description() string {
	return "Pages, blocks and data sources."
}

func (Notion) Scopes() []string { return []string{"read_content", "update_content", "insert_content"} }

func (Notion) Tools() []core.Tool {
	return withProvider("notion", []core.Tool{
		tool("notion.search", "Search pages and data sources the integration can see.", core.EffectRead),
		tool("notion.get_page", "One page's properties.", core.EffectRead),
		tool("notion.get_page_content", "A page's blocks, flattened to text.", core.EffectRead),
		tool("notion.query_data_source", "Query a data source with filters and sorts.", core.EffectRead),

		tool("notion.create_page", "Create a page.", core.EffectWrite),
		tool("notion.update_page", "Change a page's properties or content.", core.EffectWrite),
	})
}

func (Notion) MCPServer(credential string) core.MCPServerConfig {
	return core.MCPServerConfig{
		Name:      "berry-notion",
		Transport: "stdio",
		Command:   "npx",
		Args:      []string{"-y", "@notionhq/notion-mcp-server"},
		// The Notion MCP server reads its credential from a headers blob rather
		// than a bare token variable.
		Env: map[string]string{
			"OPENAPI_MCP_HEADERS": `{"Authorization":"Bearer ` + credential +
				`","Notion-Version":"2022-06-28"}`,
		},
	}
}
