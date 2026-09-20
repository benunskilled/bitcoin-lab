# Security

## Reporting a vulnerability

If you find a security issue in Bitcoin Lab, please report it privately through **Security → Report a vulnerability** in this repository.

Include the affected version, steps to reproduce the issue and its potential impact. Please leave out passwords, RPC credentials and other private information.

Bitcoin Lab is actively maintained. I aim to respond promptly.

## Supported versions

Security fixes are provided for the latest release. Please update before checking whether an issue still occurs.

## Access to your node

Bitcoin Lab uses Bitcoin Core's RPC and ZMQ interfaces. It reads peer information and block events, and uses `addnode` and `disconnectnode` to manage connections.

The app does not access wallet files, private keys or Core's block files, and does not edit `bitcoin.conf`.

On Umbrel, the app proxy handles dashboard authentication. The dashboard has no login of its own, so direct access to its internal port also gives access to its peer-management controls.

## Connections to mining pools

When Stratum Race is enabled, Bitcoin Lab opens connections to the selected pools and reads their mining-job messages. It authorises with a public burn address and never submits mining shares.

Stratum Race is off on a fresh install. While it is disabled, no pool connections are open.

## Other reports

For ordinary bugs, display issues or unexpected rankings, please open a GitHub issue. Report problems in Bitcoin Core, Umbrel or pool software to their respective maintainers.
