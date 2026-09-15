# Third-party notices

src/registration.ts adapts the device registration protocol from
larksuite/cli internal/auth/app_registration.go at commit 39aaf9f.
Copyright (c) 2026 Lark Technologies Pte. Ltd. Licensed under MIT;
see LARK_CLI_LICENSE. No CLI profile or keychain is read or modified.

The workbench uses Semi Design (MIT), React (MIT), and qrcode (MIT).
Their original licenses are retained in the installed packages.

src/registration-link.ts adapts the public registerApp URL options and gzip/base64url
addons encoding from @larksuiteoapi/node-sdk 1.73.3 (MIT).
Copyright (c) 2022 Lark Technologies Pte. Ltd.; see LARK_SDK_LICENSE.
The surrounding persisted registration workflow is local project code.
