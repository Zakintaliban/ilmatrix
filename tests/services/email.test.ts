import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import config from "../../src/config/env.js";
import { sendVerificationEmail, sendWelcomeEmail, setEmailSender, type EmailMessage } from "../../src/services/emailService.js";

const NAME = '<a href="https://evil.example/login">Akunmu diblokir, klik di sini</a>\nPS: <img src=x>';
const savedFrom = config.emailFromAddress;

function capture(): EmailMessage[] {
  const sent: EmailMessage[] = [];
  config.emailFromAddress = "noreply@example.com";
  setEmailSender(async (message) => {
    sent.push(message);
  });
  return sent;
}

afterEach(() => {
  setEmailSender(null);
  config.emailFromAddress = savedFrom;
});

test("a name with HTML can't inject links or images into the verification email", async () => {
  const sent = capture();
  assert.equal(await sendVerificationEmail({ email: "siswa@example.com", name: NAME, token: "abc123" }), true);
  const { html, text } = sent[0];

  assert.ok(!html.includes('<a href="https://evil.example'), "no injected link");
  assert.ok(!html.includes("<img"), "no injected image");
  assert.ok(html.includes("&lt;a href=&quot;https://evil.example/login&quot;&gt;"), "shown as text");
  assert.match(html, /href="[^"]*\/api\/auth\/verify-email\?token=abc123"/, "the real link is intact");
  assert.ok(text!.includes("Hi <a href"), "plain text keeps the name as text");
  assert.ok(!/Hi [^\n]*\n\s*PS:/.test(text!), "newlines in the name can't start new lines in the email");
});

test("the welcome email escapes the name too", async () => {
  const sent = capture();
  assert.equal(await sendWelcomeEmail({ email: "siswa@example.com", name: NAME }), true);
  assert.ok(!sent[0].html.includes('<a href="https://evil.example'));
  assert.ok(sent[0].html.includes("&lt;img src=x&gt;"));
});

test("the verification token is URL-encoded in the link", async () => {
  const sent = capture();
  await sendVerificationEmail({ email: "siswa@example.com", name: "Siswa", token: "a&b=c" });
  assert.ok(sent[0].html.includes("token=a%26b%3Dc"));
});

test("nothing is sent without a sender", async () => {
  config.emailFromAddress = "noreply@example.com";
  setEmailSender(null);
  assert.equal(await sendVerificationEmail({ email: "siswa@example.com", name: "Siswa", token: "t" }), false);
});
