# den-onboarding-redirect-order — only the current sign-in may redirect to onboarding

1. A successful Den sign-in starts a bounded wait for the active organization that is selected asynchronously after authentication.

2. If another session event arrives, the user signs out, or the shell unmounts before that organization appears, OpenWork cancels the older wait instead of leaving background timers alive.

3. Only the latest successful sign-in with both a current token and active organization can navigate to onboarding, and it navigates once rather than letting overlapping timers repeat the redirect.

4. If no organization becomes available within the existing five-second window, the wait ends quietly and leaves the user on their current route without a late surprise navigation.
