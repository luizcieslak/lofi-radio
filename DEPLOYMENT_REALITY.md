# Railway Deployment Reality Check

## TL;DR

**Railway SSH does NOT support file uploads via stdin piping.**

After testing, we discovered that `railway ssh` is an interactive shell executor, not a full SSH implementation. It cannot:

- ❌ Accept piped stdin (`cat file | railway ssh "cat > remote"` fails)
- ❌ Transfer files directly
- ❌ Support traditional SSH features like scp/rsync

## Tested Solutions That Failed

1. ❌ Direct tarball piping
2. ❌ Base64 encoding through SSH
3. ❌ Individual file uploads via cat
4. ❌ All fail at the stdin piping stage

## Working Solutions

### ✅ Solution 1: Include Songs in Docker Image (RECOMMENDED)

**Status:** Already configured! Songs removed from `.dockerignore`.

**Deploy:**

```bash
railway up
```

**Pros:**

- Simple and reliable
- 231MB is perfectly acceptable for Railway
- No upload complexity
- Works with GitHub integration

**Cons:**

- ~5-10 second downtime when updating songs
- Need to rebuild to change songs

**When to update songs:**

```bash
# Add/remove songs locally
cp new-song.mp3 songs/
rm songs/old-song.mp3

# Redeploy
git add songs/
git commit -m "Update playlist"
git push origin main
# Railway auto-deploys
```

### ✅ Solution 2: HTTP Upload API (Zero Downtime)

If you need to update songs without redeploying:

1. Add upload endpoint to your app
2. Use Railway volume for persistence
3. Upload via HTTP POST

**Implementation:**

```typescript
// In src/server.ts
app.post('/admin/upload-song', upload.single('file'), (req, res) => {
	// Save to /app/songs
	// Trigger playlist reload
})
```

**Usage:**

```bash
curl -F "file=@new-song.mp3" https://your-app.railway.app/admin/upload-song
```

**Pros:**

- Zero downtime
- No rebuild needed
- Works through Railway's network

**Cons:**

- Requires code changes
- Need authentication
- More complex

### ❌ Solution 3: Railway Volume + SSH Upload

**Does not work** - Railway SSH doesn't support file piping.

## Recommendation

**For your use case (231MB, infrequent updates):**

👉 **Use Solution 1 (Docker image)** - It's already set up and working!

The 5-10 second downtime during song updates is acceptable for a radio service. Listeners will just reconnect, like any streaming service restart.

**Only implement Solution 2 if:**

- You update songs multiple times per day
- Zero downtime is critical
- You want an admin UI for playlist management

## Next Steps

```bash
# Deploy with songs included
railway up

# That's it! 🎉
```

Your songs are already configured to be included in the Docker image. Just deploy.
