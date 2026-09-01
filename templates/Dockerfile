# syntax=docker/dockerfile:1
ARG BASE_IMAGE=docker.io/docker/sandbox-templates:codex-docker
FROM ${BASE_IMAGE} AS refreshed

ARG TARGETARCH
ARG NODE_VERSION
ARG AGENT_PACKAGE
ARG AGENT_VERSION
ARG AGENT_COMMAND
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "Unsupported Node.js architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"; \
    workdir="$(mktemp -d)"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "${workdir}/${archive}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${workdir}/SHASUMS256.txt"; \
    grep "  ${archive}\$" "${workdir}/SHASUMS256.txt" | (cd "${workdir}" && sha256sum -c -); \
    tar -xzf "${workdir}/${archive}" --strip-components=1 -C /usr/local; \
    rm -rf "${workdir}"; \
    node --version; \
    npm --version
RUN npm install --global --allow-scripts="${AGENT_PACKAGE}" "${AGENT_PACKAGE}@${AGENT_VERSION}" \
    && global_agent_command="$(npm prefix --global)/bin/${AGENT_COMMAND}" \
    && current_agent_command="$(command -v "${AGENT_COMMAND}")" \
    && if [ "${current_agent_command}" != "${global_agent_command}" ]; then \
      ln -sf "${global_agent_command}" "${current_agent_command}"; \
    fi \
    && npm cache clean --force \
    && "${AGENT_COMMAND}" --version
ARG COREPACK_VERSION
ARG GET_PNPM_VERSION
ARG PNPM_VERSION
ARG YARN_VERSION
RUN npm install --global "corepack@${COREPACK_VERSION}" \
    && corepack enable yarn \
    && npm cache clean --force
USER agent
ENV PNPM_HOME=/home/agent/.local/share/pnpm \
    PATH=/home/agent/.local/share/pnpm/bin:${PATH}
RUN corepack install --global "yarn@${YARN_VERSION}" \
    && SHELL=/bin/bash npx --yes "get-pnpm@${GET_PNPM_VERSION}" "${PNPM_VERSION}" \
    && npm cache clean --force \
    && pnpm --version \
    && yarn --version

FROM refreshed AS default

FROM refreshed AS tauri
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential ccache clang cmake curl file glslang-tools glslc \
      libayatana-appindicator3-dev libclang-dev libdbus-1-dev libgtk-3-dev \
      librsvg2-dev libssl-dev libvulkan-dev libwebkit2gtk-4.1-dev libxdo-dev \
      patchelf pkg-config spirv-headers wget \
    && rm -rf /var/lib/apt/lists/*

USER agent
ENV RUSTUP_HOME=/home/agent/.rustup \
    CARGO_HOME=/home/agent/.cargo \
    PATH=/home/agent/.cargo/bin:${PATH}
ARG RUST_VERSION
RUN curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile default --default-toolchain "${RUST_VERSION}" \
    && rustc --version \
    && cargo --version

FROM default AS smoke-default
ARG AGENT_COMMAND
ARG NODE_VERSION
ARG PNPM_VERSION
ARG YARN_VERSION
RUN "${AGENT_COMMAND}" --version \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && test "$(command -v pnpm)" = "${PNPM_HOME}/bin/pnpm" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(yarn --version)" = "${YARN_VERSION}" \
    && test "$(id -un)" = agent

FROM tauri AS smoke-tauri
ARG AGENT_COMMAND
ARG NODE_VERSION
ARG PNPM_VERSION
ARG YARN_VERSION
RUN "${AGENT_COMMAND}" --version \
    && test "$(node --version)" = "v${NODE_VERSION}" \
    && test "$(command -v pnpm)" = "${PNPM_HOME}/bin/pnpm" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(yarn --version)" = "${YARN_VERSION}" \
    && rustc --version \
    && cargo --version \
    && clang --version \
    && cmake --version \
    && ccache --version \
    && glslc --version \
    && glslangValidator --version \
    && pkg-config --exists dbus-1 gtk+-3.0 webkit2gtk-4.1 librsvg-2.0 openssl vulkan \
    && dpkg-query -W libclang-dev >/dev/null \
    && dpkg-query -L spirv-headers | grep -q '/SPIRV-HeadersConfig.cmake$' \
    && test -f /usr/include/xdo.h

FROM refreshed AS bun
ARG BUN_VERSION
USER root
RUN npm install --global "bun@${BUN_VERSION}" \
    && npm cache clean --force \
    && bun --version
USER agent

FROM bun AS smoke-bun
ARG NODE_VERSION
ARG PNPM_VERSION
ARG YARN_VERSION
RUN test "$(node --version)" = "v${NODE_VERSION}" \
    && test "$(command -v pnpm)" = "${PNPM_HOME}/bin/pnpm" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(yarn --version)" = "${YARN_VERSION}" \
    && bun --version \
    && test "$(id -un)" = agent
