Optional extra root CA certificates, copied into the agent image and trusted.

Only needed when something on the host terminates TLS (antivirus, corporate proxy). On the
measured host that was Kaspersky: export its root CA as PEM, save it here as `<name>.crt`,
rebuild. `*.crt` files in this directory are git-ignored — they are host-specific.
