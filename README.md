<p align="center">
  <img src="assets/readme/hero.svg" alt="dsh-codebuddy-sdk — CodeBuddy as a DeepSeek Harness LLM provider (WIP)" width="100%">
</p>

# dsh-codebuddy-sdk

Registers **CodeBuddy** (Tencent Agent SDK) as an LLM provider adapter for DeepSeek Harness (`ctx.llm`).

> Port of [pi-codebuddy-sdk](https://github.com/RetiredPhysicist/pi-plugins/tree/main/packages/pi-codebuddy-sdk).

[English](README.md) · [中文](README.zh.md)

## Status — WIP

> Skeleton for now: the adapter mounts and streams a placeholder response.
> The real integration is next:
>
> - ❌ multi-turn message translation (`GenerateOptions.messages` → CodeBuddy)
> - ❌ tool-call streaming (dsh `StreamChunk` tool blocks)
> - ❌ on-device verification against the local `codebuddy` CLI
>
> Track progress at [RealAlexandreAI/dsh-codebuddy-sdk/issues](https://github.com/RetiredPhysicist/dsh-plugins/issues).

## Quick start

```sh
dsh plugin add dsh-codebuddy-sdk
```

Requires the `codebuddy` CLI on `PATH` (same requirement as pi-codebuddy-sdk).

```yaml
- id: codebuddy
  name: dsh-codebuddy-sdk
  config:
    provider: codebuddy   # provider route (default codebuddy)
    model: codebuddy      # default model id (default codebuddy)
```

## Privacy

- Talks to the local `codebuddy` CLI only; no extra network hop.
- No credentials are read or stored by this plugin (CLI auth is reused).

## Development

```bash
npm install
npm run typecheck
npm test          # mount + placeholder stream smoke
npm run build
```

## License

MIT
