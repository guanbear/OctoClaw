# Changelog

## 0.1.0

Public release based on internal milestone `v1.5.0`.

### Added

- Cost-sensitive role-aware model policy generation
- Session-aware patrol with steer-before-redispatch
- Persistent runner queue, dispatch entry, daemon, and health checks
- Generic text status rendering (`compact`, `table`, `lanes`)
- Configurable notification backend (`feishu`, `auto`, `none`)

### Notes

- This draft is optimized for a minimal usable OpenClaw workflow first
- Feishu support remains optional; text-mode status and runner flow are the recommended default open-source path
