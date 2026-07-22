# new-signin-flow — Deterministic email-first sign-in

1. The sign-in screen starts simple: one email address field and one **Next** button.

2. After entering an email, OpenWork checks the backend and chooses the right next step.

3. If the email belongs to an org with SSO, the next screen only shows **Sign in with SSO**.

4. If the email uses Google, the next screen only shows **Sign in with Google**.

5. If the email uses a password, the next screen shows the password field and sign-in button.

6. If the email is new, the screen becomes **Create an account** with email, name, a separator, **Sign up with Google**, password, and **Sign up**.
