#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/SecTask.h>

// A separate diagnostic bundle, never part of the production app. It checks
// the browser API and authorization prerequisites without reading credentials,
// requesting consent, or attempting a website sign-in.
int main(void) {
  @autoreleasepool {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    CFTypeRef value = task ? SecTaskCopyValueForEntitlement(task,
        CFSTR("com.apple.developer.web-browser.public-key-credential"), NULL) : NULL;
    BOOL entitlement = value && CFGetTypeID(value) == CFBooleanGetTypeID()
        && CFBooleanGetValue(value);
    if (value) CFRelease(value);
    if (task) CFRelease(task);

    NSMutableDictionary *result = [@{
      @"bundleId": NSBundle.mainBundle.bundleIdentifier ?: @"",
      @"browserEntitlement": @(entitlement),
      @"nativeBrowserApiAvailable": @NO,
      @"authorizationState": @"missing-entitlement",
      @"passkeySignInTested": @NO,
    } mutableCopy];

    if (@available(macOS 13.5, *)) {
      result[@"nativeBrowserApiAvailable"] = @YES;
      if (entitlement) {
        ASAuthorizationWebBrowserPublicKeyCredentialManager *manager =
            [[ASAuthorizationWebBrowserPublicKeyCredentialManager alloc] init];
        switch (manager.authorizationStateForPlatformCredentials) {
          case ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized:
            result[@"authorizationState"] = @"authorized";
            break;
          case ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateDenied:
            result[@"authorizationState"] = @"denied";
            break;
          case ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateNotDetermined:
            result[@"authorizationState"] = @"not-determined";
            break;
          default:
            result[@"authorizationState"] = @"unknown";
        }
      }
    } else {
      result[@"authorizationState"] = @"unsupported-macos";
    }
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:&error];
    if (!json) {
      fprintf(stderr, "Cannot encode diagnostic result: %s\n", error.localizedDescription.UTF8String);
      return 1;
    }
    puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
  }
}
