# Security Specification - MapShare Live

## Data Invariants
1. A user document must have a `uid` matching the document ID.
2. The `role` can only be set to `admin` by existing admins or during initial bootstrap (for the specific owner email).
3. `updatedAt` must always be the server time.
4. `location` must be a valid object with `lat` and `lng`.
5. Only the account owner or an admin can read a user's location.

## The Dirty Dozen Payloads
1. **Identity Spoofing**: Attempt to create a user profile for a different UID.
2. **Privilege Escalation**: Attempt to set `role: 'admin'` on one's own profile.
3. **Ghost Field Injection**: Add `isVerified: true` to the location update.
4. **Invalid Location**: Set `lat` to a 1MB string.
5. **Orphaned Write**: Update location without `updatedAt`.
6. **Time Spoofing**: Provide a manual `updatedAt` from 10 years ago.
7. **Unauthorized Read**: Standard user tries to list all users.
8. **ID Poisoning**: User document ID with 2KB of junk characters.
9. **Role Mutation**: Standard user tries to change their role back to `admin` after being demoted.
10. **Admin Bypass**: Attempt to delete another user's profile as a standard user.
11. **Email Spoofing**: Claim to be the admin email without `email_verified == true`.
12. **PII Leak**: Attempting to read the `users` collection without being an owner or admin.

## Test Runner (Planned)
The `firestore.rules` will be tested against these cases.
