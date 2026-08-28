import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AccountSecurityPanel, type AccountSecurityPanelProps } from "../app/account-security-panel.tsx";

const baseProps: AccountSecurityPanelProps = {
  accountLabel: "QA Admin",
  accountLogin: "qa-admin",
  mfaEnabled: false,
  sessions: [],
  onChangePassword: () => undefined,
  onBeginMfa: () => undefined,
  onVerifyMfa: () => undefined,
  onDisableMfa: () => undefined,
  onRevokeSessions: () => undefined,
};

test("keeps the MFA setup password inside the form that submits it", () => {
  const html = renderToStaticMarkup(<AccountSecurityPanel {...baseProps} mfaSetup={null} />);
  const beginForm = html.match(/<form class="account-security-actions">([\s\S]*?)<\/form>/)?.[1] ?? "";

  assert.match(beginForm, /type="password"/);
  assert.match(beginForm, /name="username"/);
  assert.match(beginForm, /autoComplete="username"/);
  assert.match(beginForm, /value="qa-admin"/);
  assert.match(beginForm, /name="currentPassword"/);
  assert.match(beginForm, /type="submit"[^>]*disabled/);
  assert.doesNotMatch(html.replace(`<form class="account-security-actions">${beginForm}</form>`, ""), /type="password"/);
});

test("keeps the setup-confirmation password inside the MFA verification form", () => {
  const html = renderToStaticMarkup(<AccountSecurityPanel
    {...baseProps}
    mfaSetup={{ secret: "QA-SECRET", otpauthUri: "otpauth://totp/QA", mfaVersion: 1 }}
  />);
  const verificationForm = html.match(/<form class="form-grid account-mfa-form">([\s\S]*?)<\/form>/)?.[1] ?? "";

  assert.match(verificationForm, /type="password"/);
  assert.match(verificationForm, /name="username"/);
  assert.match(verificationForm, /autoComplete="username"/);
  assert.match(verificationForm, /value="qa-admin"/);
  assert.match(verificationForm, /name="currentPassword"/);
  assert.match(verificationForm, /autoComplete="one-time-code"/);
  assert.doesNotMatch(html.replace(`<form class="form-grid account-mfa-form">${verificationForm}</form>`, ""), /type="password"/);
});
