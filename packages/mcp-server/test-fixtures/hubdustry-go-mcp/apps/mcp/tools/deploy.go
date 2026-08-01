// FIXTURE: minimal Go for adapter testing - not real code
// Two NewTool calls (trigger/status). Combined with files.go the
// fixture exposes 5 tools total - the adapter must report all 5 as
// unmappedTools (NAME_MAP is empty for Hubdustry).
package tools

import "example.com/hubdustry/mcp"

func RegisterDeployTools() {
	_ = mcp.NewTool("server.deploy.trigger", mcp.WithDescription("Trigger a deploy job"))
	_ = mcp.NewTool("server.deploy.status", mcp.WithDescription("Read the current deploy status"))
}
