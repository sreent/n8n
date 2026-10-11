# The logos of the secrets providers

Fork content (not in upstream n8n). The settings page of external secrets shows these logos on the
cards of the provider types and in the provider modal. The fork downloaded them on 2026-10-11. The
owner chose the official logos of the vendors on 2026-10-11, also for the icons whose terms name
only diagrams and documentation.

| File | Provider type | Source | Terms or licence | Changes |
|---|---|---|---|---|
| `aws-secrets-manager.svg` | AWS Secrets Manager | AWS Architecture Icons, icon package of 2026-07-31, `Arch_Security-Identity/64/Arch_AWS-Secrets-Manager_64.svg` (aws.amazon.com/architecture/icons) | AWS lets customers and partners use the icons to make architecture diagrams. | None |
| `azure-key-vault.svg` | Azure Key Vault | Azure Public Service Icons V24, `Icons/security/10245-icon-service-Key-Vaults.svg` (learn.microsoft.com/azure/architecture/icons) | Microsoft permits the icons in architectural diagrams, training materials or documentation. | None |
| `gcp-secrets-manager.svg` | GCP Secrets Manager | Google Cloud legacy icons, `secret_manager/secret_manager.svg` (cloud.google.com/icons) | Google gives the icons for diagrams and technical documentation. | None |
| `hashicorp.svg` | HashiCorp Vault | `@hashicorp/flight-icons` 5.3.0, `svg/vault-color-24.svg` (the icon set of the HashiCorp sites) | Mozilla Public License 2.0, copyright (c) 2021 HashiCorp, Inc. See the notice in the file. | A licence comment |
| `infisical.svg` | Infisical | github.com/Infisical/infisical, `frontend/public/images/gradientLogo.svg` | MIT licence (below) | A licence comment |
| `one-password.svg` | 1Password | 1password.com, `/favicon/icon-v2.svg` (the icon of the site that has the 1Password press page) | Logo of AgileBits Inc. | A `viewBox`, so that the logo scales |

The logos are trademarks of their owners. The fork uses them only to show which product a card is
for. The fork is for internal business use only.

The build removes the comments and the `<title>` elements from the inline logos (SVGO in
`vite.config.mts`).

## The MIT licence of `infisical.svg`

Copyright (c) 2022 Infisical Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
