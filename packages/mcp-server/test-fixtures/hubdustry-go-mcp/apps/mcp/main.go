// FIXTURE: minimal Go for adapter testing - not real code
// Synthetic stand-in for hubdustry/apps/mcp/main.go used by
// hubdustry-go-mcp.test.ts. Only needs to mention `hubdustry` (or
// the mcp.NewTool pattern) so the adapter's detect() returns true.
package main

import (
	"fmt"

	"example.com/hubdustry/mcp/tools"
)

func main() {
	fmt.Println("hubdustry mcp fixture")
	tools.RegisterFileTools()
	tools.RegisterDeployTools()
}
