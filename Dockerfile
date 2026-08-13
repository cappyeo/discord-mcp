# syntax=docker/dockerfile:1

# This image intentionally starts the credential-free catalog command so MCP
# registries can inspect the real tool contracts without a Discord bot token.
# Operational callers should use the npm package, or override CMD with `serve`
# and provide their own DISCORD_TOKEN.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-core/package.json packages/mcp-core/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/mcp-server-mocks/package.json packages/mcp-server-mocks/package.json

RUN pnpm install --frozen-lockfile --filter @discord-mcp/cli...

COPY LICENSE README.md ./
COPY packages/mcp-core packages/mcp-core
COPY packages/mcp-server packages/mcp-server

RUN pnpm --filter @discord-mcp/core build \
 && pnpm --filter @discord-mcp/cli build \
 && pnpm deploy --filter @discord-mcp/cli --prod /runtime

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ENV NODE_ENV=production
WORKDIR /app

LABEL org.opencontainers.image.title="Discord MCP catalog" \
      org.opencontainers.image.description="Credential-free schema catalog for MCP registry inspection; Discord execution is disabled by default." \
      org.opencontainers.image.source="https://github.com/cappyeo/discord-mcp" \
      org.opencontainers.image.documentation="https://cappyeo.github.io/discord-mcp/" \
      org.opencontainers.image.licenses="MIT"

COPY --from=build --chown=node:node /runtime/ ./
COPY --from=build --chown=node:node /workspace/LICENSE /licenses/discord-mcp/LICENSE

USER node

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["catalog"]
