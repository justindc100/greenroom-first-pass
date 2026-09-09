# Greenroom iOS host smoke

Disposable, Greenroom-owned native iOS fixture plus a no-model smoke workflow (`.github/workflows/ios-host-smoke.yml`, dispatched by hand). It measures how often and how long the hosted macos-26 simulator's display-capture and accessibility paths stall on the 0.3.13 preparation path, using only the agent-device CLI vendored in the public runner repository. No model is called, no Greenroom run is minted, nothing talks to the control plane, and no customer code or credentials are present. Findings are recorded on Greenroom issue GR-12.
