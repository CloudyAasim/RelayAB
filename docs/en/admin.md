# Admin Guide

> Operational guide for administrators of the RelayAB AI gateway.

---

## 1. Accessing the Admin Panel

Go to `/admin` and sign in with an administrator account to enter the admin panel.

The admin panel contains the following modules:
- **Users** (`/admin/users`) - create, edit, and delete users
- **API keys** (`/admin/keys`) - view, create, enable/disable, and delete API keys
- **Providers** (`/admin/providers`) - manage the AI upstream provider configurations
- **Media providers** (`/admin/media-providers`) - declarative media provider specs
- **Usage** (`/admin/usage`) - usage statistics
- **Settings** (`/admin/settings`) - system-wide settings
- **Docs** (`/admin/docs`) - the media adapter protocol, rendered from the repository

---

## 2. User Management

### 2.1 Create a User

1. Open the **Users** page
2. Click the **Create New User** button
3. Fill in the form:
   - **Username** - login credential, required, 3-32 characters
   - **Password** - optional; **leave it empty to have a strong password generated
     for you**. Anything you type is used verbatim.
   - **Display Name** - shown in the UI, optional
   - **Role** - `admin` (administrator) or `user` (regular user)
4. Click **Create** to finish

### 2.2 Assign a Quota

Each user has one shared quota pool, and all of that user's keys are billed from the same pool.

1. Find the target user in the user list
2. Click the **Configure** button at the bottom right of the user card
3. Configure the following in the dialog:
   - **Quota type** - `Credits` or `Tokens`
   - **Total credits** - an integer; new calls are rejected once it is exceeded
   - **Quick add:** - click +100 / +500 / +1000 to top the quota up quickly
   - **Allowed models** - empty = every model is available; otherwise a list of permitted models
   - **Active-key cap** - 0 = no cap

### 2.3 Cut a User Off (There Is No Disable Switch)

> **A user cannot be disabled.** Earlier versions of this document described a
> Disable / Enable action; it does not exist — there is no `disabled` field on a
> user, no toggle endpoint, and no `user_disabled` error code. To stop a user's
> access, use one of these instead:

- Set **Total credits** to `0` in **Configure** — every call from that user's keys
  is rejected with `quota_exceeded_credits` (or `quota_exceeded_tokens`), and the
  panel login is unaffected.
- Delete their keys individually from **API keys**, if you want the account to
  survive but the credentials to stop working.
- Delete the user (see §2.5) if the account should be gone.

Disabling a user's *keys* is a separate, real feature — see §3.3.

### 2.4 Reset the Password

1. Choose **Reset Password** in the actions menu
2. The system generates a new random password, shown only once - copy and store it immediately
3. Have the user sign in with the new password and change it themselves

### 2.5 Delete a User

> ⚠️ Warning: deleting a user also deletes all of their API keys. This action cannot be undone.

1. Choose **Delete** in the actions menu
2. Confirm the prompt to delete permanently

---

## 3. API Key Management

### 3.1 Create a Key

1. Open the **API keys** page
2. Click the **Create API Key** button
3. Fill in the form:
   - **User** - required, pick from the dropdown
   - **Label** - identifying name, e.g. "Alice's laptop"
   - **Expires At** - optional; leave empty for a key that never expires
   - **Allowed Models** - optional, comma-separated; leave empty to inherit the owner's model whitelist
4. Click **Create**
5. **Important**: once creation succeeds the plaintext key is displayed **only once** - copy and store it immediately

### 3.2 Keys and Quotas

> A quota belongs to the user, not to the key. All of a user's keys share the same quota pool.

This means:
- you give Alice 1000 credits, and she creates keys A / B / C
- any call through A, B, or C draws from that same 1000
- once the 1000 is used up, all three keys stop working together
- creating more keys does not grant more quota

### 3.3 Enable / Disable a Key

1. In the key list, click the **⋮** button in the actions column
2. Choose **Disable** or **Enable**
3. `forceDisabled` is set by an administrator, and an ordinary enable/disable action cannot override it

### 3.4 Delete a Key

1. Choose **Delete** in the actions menu
2. Confirm to delete permanently

---

## 4. Upstream Provider Management

### 4.1 Add a Provider

1. Open the **Providers** page
2. Click the **Add Upstream Provider** button
3. Fill in the configuration:
   - **Name** - identifying name, visible to administrators
   - **Kind** - `openai` / `anthropic` / `custom-openai` / `azure`
   - **Base URL** - the upstream API root address
   - **API key** - the upstream API key (stored encrypted)
   - **Priority** - the lower the number, the higher the priority
   - **Upstream format** - `Responses` (default) / `Chat` / `Messages`
   - **Model Mapping** - client model name → upstream model name; an identity mapping is recommended

### 4.2 Test a Provider

Before saving, click the **Test connection** button to verify that the configuration is correct.

---

## 5. Public API Endpoints

Users consume the AI service through the following endpoints:

| Endpoint | Protocol | Description |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI Chat | |
| `/v1/responses` | OpenAI Responses | |
| `/v1/models` | OpenAI | returns the list of available models |
| `/anthropic/v1/messages` | Anthropic | Claude compatible |

Authentication:
```
Authorization: Bearer sk-relay-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 6. Error Codes

| HTTP | code | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | missing or invalid Bearer token |
| 403 | `key_disabled` | the key is disabled |
| 403 | `key_force_disabled` | the key was force-disabled by an administrator |
| 403 | `key_expired` | the key has expired |
| 403 | `quota_exceeded_credits` | not enough credits |
| 403 | `quota_exceeded_tokens` | not enough token quota |
| 403 | `model_not_allowed` | this key is not allowed to use this model |
| 400 | `model_not_mapped` | no provider supports this model |
| 400 | `missing_model` | the request body has no `model` field |
| 502 | `upstream_error` | the upstream call failed |

> There is **no `user_disabled` code** — it appeared in earlier versions of this
> table but nothing in the codebase produces it, because users cannot be disabled.
> The codes that stop a user are `quota_exceeded_credits` / `quota_exceeded_tokens`
> (quota set to 0) and the key-level codes above.

---

## 7. Debugging Tips

### 7.1 Check a User's Real Quota State

```bash
# read the user record straight out of Redis
# (the env var names RelayAB itself uses; see config.ts — KV_REST_API_* is the
#  legacy alias some Marketplace injects, and works here too)
curl -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/hgetall relay:user:<userId>"
```

Compare `quotaLimit` with `quotaUsed`. Credits are stored in units of 0.001 credit,
so a `quotaLimit` of `100000` means 100 credits. When `quotaUsed` has reached
`quotaLimit`, calls fail with `quota_exceeded_credits` (or
`quota_exceeded_tokens` when `quotaType` is `tokens`).

### 7.2 Why Can a User Still Call After I "Turned Them Off"?

Because a user cannot be turned off — see §2.3. What actually stops calls:

- Quota reaching its limit stops **API calls**, but the user can still sign in to
  the panel until their session expires.
- Disabling or force-disabling a **key** stops that key immediately; the user
  still holds every other key they have.
- There is no user-level kill switch, so the only way to stop all access is to
  delete the user (which deletes their keys too).
