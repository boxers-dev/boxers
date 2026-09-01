variable "IMAGE" { default = "ghcr.io/boxers-dev/boxers-templates" }
variable "AGENT" { default = "codex" }
variable "BASE_IMAGE" { default = "docker.io/docker/sandbox-templates:codex-docker" }
variable "AGENT_PACKAGE" { default = "@openai/codex" }
variable "AGENT_VERSION" { default = "latest" }
variable "AGENT_COMMAND" { default = "codex" }
variable "NODE_VERSION" { default = "24.19.0" }
variable "COREPACK_VERSION" { default = "0.35.0" }
variable "GET_PNPM_VERSION" { default = "0.0.3" }
variable "PNPM_VERSION" { default = "11.24.0" }
variable "YARN_VERSION" { default = "4.18.0" }
variable "RUST_VERSION" { default = "stable" }
variable "BUN_VERSION" { default = "latest" }
variable "FINGERPRINT" { default = "dev" }
variable "TAG_SUFFIX" { default = "" }

target "common" {
  context = "."
  dockerfile = "templates/Dockerfile"
  args = {
    BASE_IMAGE = BASE_IMAGE
    AGENT_PACKAGE = AGENT_PACKAGE
    AGENT_VERSION = AGENT_VERSION
    AGENT_COMMAND = AGENT_COMMAND
    NODE_VERSION = NODE_VERSION
    COREPACK_VERSION = COREPACK_VERSION
    GET_PNPM_VERSION = GET_PNPM_VERSION
    PNPM_VERSION = PNPM_VERSION
    YARN_VERSION = YARN_VERSION
    RUST_VERSION = RUST_VERSION
    BUN_VERSION = BUN_VERSION
  }
}

target "default" {
  inherits = ["common"]
  target = "default"
  tags = [
    "${IMAGE}:${AGENT}-default-${FINGERPRINT}${TAG_SUFFIX}",
    "${IMAGE}:${AGENT}-default${TAG_SUFFIX}",
  ]
  cache-from = ["type=registry,ref=${IMAGE}:${AGENT}-default-buildcache${TAG_SUFFIX}"]
  cache-to = ["type=registry,ref=${IMAGE}:${AGENT}-default-buildcache${TAG_SUFFIX},mode=max"]
}

target "tauri" {
  inherits = ["common"]
  target = "tauri"
  tags = [
    "${IMAGE}:${AGENT}-tauri-${FINGERPRINT}${TAG_SUFFIX}",
    "${IMAGE}:${AGENT}-tauri${TAG_SUFFIX}",
  ]
  cache-from = ["type=registry,ref=${IMAGE}:${AGENT}-tauri-buildcache${TAG_SUFFIX}"]
  cache-to = ["type=registry,ref=${IMAGE}:${AGENT}-tauri-buildcache${TAG_SUFFIX},mode=max"]
}

target "bun" {
  inherits = ["common"]
  target = "bun"
  tags = [
    "${IMAGE}:${AGENT}-bun-${FINGERPRINT}${TAG_SUFFIX}",
    "${IMAGE}:${AGENT}-bun${TAG_SUFFIX}",
  ]
  cache-from = ["type=registry,ref=${IMAGE}:${AGENT}-bun-buildcache${TAG_SUFFIX}"]
  cache-to = ["type=registry,ref=${IMAGE}:${AGENT}-bun-buildcache${TAG_SUFFIX},mode=max"]
}

target "smoke-default" {
  inherits = ["common"]
  target = "smoke-default"
  output = ["type=cacheonly"]
}

target "smoke-tauri" {
  inherits = ["common"]
  target = "smoke-tauri"
  output = ["type=cacheonly"]
}

target "smoke-bun" {
  inherits = ["common"]
  target = "smoke-bun"
  output = ["type=cacheonly"]
}

group "ci" {
  targets = ["default", "tauri", "bun", "smoke-default", "smoke-tauri", "smoke-bun"]
}
