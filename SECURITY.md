# Security Policy

## Supported versions

Zevium is under active development and does not currently publish versioned
releases. Security fixes are applied to the `develop` branch. Older commits,
forks, and third-party deployments are not supported.

## Reporting a vulnerability

Do not open a public issue, discussion, or pull request for a suspected
vulnerability.

Report it privately through
[GitHub's private vulnerability reporting](https://github.com/zevium-dev/core/security/advisories/new).
Include enough detail for us to reproduce and assess the issue:

- affected component and behavior
- reproduction steps or a minimal proof of concept
- expected impact and attack prerequisites
- affected URLs, commit hashes, or configuration when relevant
- any suggested mitigation

Never include real credentials, personal data, or data belonging to another
user. Use test accounts and the minimum access needed to demonstrate the issue.

## What to expect

We aim to acknowledge reports within three business days. After validation, we
will share an initial assessment and coordinate remediation and disclosure with
the reporter. Timelines depend on severity and complexity; we will provide
updates when the assessment or expected resolution changes.

Please keep vulnerability details private until a fix is available and we have
agreed on a disclosure timeline. We will credit reporters who want attribution.

## Scope

High-value reports include authentication or authorization bypasses, cross-org
data access, credit-gate or ledger manipulation, gateway proxy abuse, secret
exposure, webhook forgery, and injection flaws.

Reports about third-party services should be sent to their maintainers unless
the issue is caused by Zevium's integration. Reports that only describe missing
best-practice headers, automated scanner output without a demonstrated impact,
social engineering, or denial of service requiring excessive traffic may be
closed without further action.

Good-faith research that follows this policy, avoids privacy violations and
service disruption, and stops after confirming the vulnerability will not be
treated as malicious activity by the Zevium maintainers.
