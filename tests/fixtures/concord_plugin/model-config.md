> [!NOTE]
>
> `ANTHROPIC_BASE_URL` changes where requests are sent, not which model answers them. To route Claude through an LLM gateway, see [LLM gateways](https://code.claude.com/docs/en/llm-gateway).

### Model aliases

Use a model alias to select model settings without remembering exact version numbers:

| Model alias | Behavior |
| - | - |
| **`default`** | Special value that clears any model override and reverts to the [runtime default for your account](#default-model-setting). Not itself a model alias |
| **`best`** | Uses the same model as `opus` |
| **`fable`** | Uses the [Fable model for your provider](#fable-alias-resolution) for your hardest and longest-running tasks |
| **`sonnet`** | Uses the latest Sonnet model for daily coding tasks |
| **`opus`** | Uses the latest Opus model for complex reasoning tasks |
| **`haiku`** | Uses the fast and efficient Haiku model for simple tasks |
| **`sonnet[1m]`** | Uses Sonnet with a [1 million token context window](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-sizes-by-model) for long sessions. No effect when `sonnet` already resolves to Sonnet 5.5 or Sonnet 5 with their native 1M window |
| **`opus[1m]`** | Uses Opus with a [1 million token context window](https://platform.claude.com/docs/en/build-with-claude/context-windows#context-window-sizes-by-model) for long sessions. No effect when `opus` already resolves to Opus 4.7 or later with its native 1M window |
| **`opusplan`** | Special mode that uses `opus` during plan mode, then switches to `sonnet` for execution |

The `opus`, `sonnet`, and `haiku` aliases resolve to the newest version on the Anthropic API and to an earlier version on some other providers:

| Provider | `opus` | `sonnet` | `haiku` |
| :- | :- | :- | :- |
| Anthropic API | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| [Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws.md) | Opus 5.5 | Sonnet 4.6 | Haiku 4.5 |
| Amazon Bedrock, Google Cloud's Agent Platform | Opus 5.5 | Sonnet 4.5 | Haiku 4.5 |
| Microsoft Foundry | Opus 4.6 | Sonnet 4.5 | Haiku 4.5 |

Unless you set `ANTHROPIC_DEFAULT_FABLE_MODEL`, the `fable` alias resolves to Fable 5 in [Claude apps gateway](https://code.claude.com/docs/en/claude-apps-gateway) sessions and to Fable 5.2 everywhere else.


Prose that must never be parsed as a candidate: use `mythos` or `claude-mythos-9` or `best` if you like.

| Variable | Description |
| - | - |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | The model to use for `opus`, or for `opusplan` when Plan Mode is active. |
