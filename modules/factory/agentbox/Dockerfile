# The box an agent runs in.
#
# Franco runs agents with permissions skipped — that is the only way an agent
# gets through a day's work without a human tapping "allow" every minute. On the
# host that means an agent can read ~/.ssh, ~/.aws, ~/.config/gh, both AI logins,
# and every repo on the machine. It has not gone wrong yet. That is luck, not
# design, and luck is not a security model.
#
# So the bypass moves inside a box. The agent still runs unrestricted — it has to,
# to be useful — but "unrestricted" now means one mounted repo and nothing else.
# Both vendors say as much about their own escape hatches: Codex's
# --dangerously-bypass-approvals-and-sandbox is documented as "intended solely for
# running in environments that are externally sandboxed". This is that environment.
#
# Harness-agnostic on purpose: the box runs a command, not a particular CLI, so a
# new agent tomorrow needs a line here and nothing else.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      ripgrep \
      curl \
      less \
      python3 \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# The agent CLIs. Add a line per harness; nothing else in the box cares which.
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# Not root. The box is the boundary, but an agent that cannot write outside its
# own home and the mounted repo is a smaller problem if the boundary ever leaks.
RUN useradd --create-home --shell /bin/bash agent
USER agent
WORKDIR /work

# Marks the environment as boxed. Anything that wants to know whether it is safe
# to skip permissions can read this rather than guess.
ENV AGENTBOX=1

CMD ["bash"]
