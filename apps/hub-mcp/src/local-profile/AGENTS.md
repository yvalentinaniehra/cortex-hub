# Local CBM profile

This is an explicitly authorized local adaptation of the MIT Cortex source. Do not activate GitNexus, Docker, external LLMs, or embedding providers from this profile. Keep the upstream entry points working. Native profile gates: build shared-types/shared-utils/hub-mcp, run the local-profile integration tests, and validate the actual STDIO connection. A full upstream dashboard/container release is outside this profile's scope. Do not edit target repositories or their .env files. No fabricated token savings. Record differences from upstream in LOCAL_PROFILE.md.
