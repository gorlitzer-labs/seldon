# comb

Keep your keys out of your conversations.

You paste a Cloudflare token to an agent so it can do a job. That token is now in
a transcript file on your disk, in plaintext, forever. Do it enough times and you
no longer know which credentials are exposed, or which ones to rotate — so you
rotate none of them.

`comb` is a small front-end over [SOPS](https://github.com/getsops/sops) and
[age](https://github.com/FiloSottile/age). Secrets are referred to by **name**.
Values go into a child process's environment and nowhere else: not into a shell,
not into history, not into the conversation.

```bash
comb init
comb set CF_API_TOKEN --url https://dash.cloudflare.com/profile/api-tokens
comb run --with CF_API_TOKEN -- curl -H "Authorization: Bearer $CF_API_TOKEN" ...
comb audit
```

## Why not a secrets server

Infisical and OpenBao are good. They are also a database, a cache, a patch
cadence, and something that can be down at 3am when an agent needs a key. For one
person that is overhead you will resent.

SOPS and age are two static binaries and an encrypted file. Identical on macOS
and Linux, identical in a container. "Self-hosted" is literally true: nothing
leaves the machine, and there is no host to compromise.

The encrypted store is safe to commit. Put it in a private repo and you get
versioning and offsite backup for free, plus a history of when each key changed —
which is the only rotation record anyone actually keeps.

**The cost, stated plainly:** the age private key is the one credential that
matters. Everything else is recoverable; that is not. Back it up somewhere real.

## Commands

| command | |
|---|---|
| `comb init` | create the age key and the encrypted store |
| `comb set <NAME> [--url <where>]` | take a value without echoing it, and store it |
| `comb ls` | names, dates and notes — never values |
| `comb run --with A,B -- <cmd>` | run a command with those secrets in its environment |
| `comb rotate <NAME>` | tell you where to go, then take the new value |
| `comb audit` | which secrets leaked into transcripts and shell history |
| `comb rm <NAME>` | forget one (does **not** revoke it at the provider) |

Values are never printed, never passed as command-line arguments, never logged.
`comb get NAME --reveal` exists for when you genuinely need to read one, and
refuses without the flag.

## `comb audit`

This is the half no vault does, and the half that makes manual rotation
survivable. "Rotate everything just in case" is advice nobody follows twice.
Knowing that three specific keys are sitting in a transcript turns a day of work
into ten minutes.

```
comb audit  scanning 5 place(s) credentials go to be forgotten
  · Claude transcripts   · Codex sessions   · Codex history
  · zsh history          · bash history

  LEAKED  CF_API_TOKEN — 2 occurrence(s) across 1 file(s): Claude transcripts

  credential-shaped strings (not necessarily yours):
  GitHub token — 3 distinct, 3 occurrence(s), 2 file(s)
  private key block — 1 distinct, 3 occurrence(s), 2 file(s)
```

Two kinds of finding, and the difference matters:

- **LEAKED** — a value from your own store, found verbatim. Certain.
- **shaped** — something that looks like a credential by its prefix. Probable,
  and biased: a GitHub token announces itself with `ghp_`, while a Cloudflare
  token is forty characters of nothing in particular and cannot be recognised at
  all. **Finding none proves nothing.**

## Rotation is manual, on purpose

To rotate a credential automatically you need a credential that can rotate
credentials — a Cloudflare token with Edit-API-Tokens, a GitHub PAT with admin
scope. That meta-credential is strictly more dangerous than the ones it replaces,
it lives in the same store, and nothing can rotate *it*. Automating this would
trade a small risk for a bigger one.

So `comb rotate` does the part a tool should: reminds you where to go, takes the
new value without echoing it, records when it changed, and leaves revoking the
old one to you — after you have confirmed the new one works.

## What this does not do

A process that *uses* a secret can *read* it. `comb` cannot stop an agent seeing
a token you have handed it to work with. What it stops is the token entering a
conversation, a file, or your shell history in the first place — and it makes
rotating one cheap enough that you actually do it.

## Requires

`sops` and `age` on PATH (`brew install sops age`, or your package manager).
Node 20+.

MIT.
