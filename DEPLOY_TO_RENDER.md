# 🚀 Deploy ERIX-Store to Render (Production)

**Date**: May 10, 2026  
**Status**: Ready for Production Deployment

---

## 📋 Pre-Deployment Checklist

### ✅ What's Already Configured

1. **✅ Dockerfile** - Multi-stage build with Node.js 20
2. **✅ render.yaml** - Blueprint for one-click deployment
3. **✅ Health Check** - `/health` endpoint configured
4. **✅ Environment Variables** - Template ready
5. **✅ PostgreSQL Schema** - Snapshot table auto-created
6. **✅ Client Package** - `@ecodrix/erix-client` ready for use

### ⚠️ What You Need to Prepare

1. **GitHub Repository** - Push code to GitHub
2. **Render Account** - Sign up at render.com
3. **PostgreSQL Database** - Supabase or Render Postgres
4. **API Key** - Generate secure key for authentication

---

## 🔧 Step 1: Generate API Key

```bash
# Generate a secure API key
node -e "console.log('erix_' + require('crypto').randomBytes(32).toString('hex'))"
```

**Example output**:
```
erix_19d13b9a9a9e72f0c9d65f2de05cdf70fa1b7b3d64d845b89f49f39501aedac3
```

**Save this key** - you'll need it for both ERIX-Store and your server configuration.

---

## 🗄️ Step 2: Setup PostgreSQL Database

### Option A: Use Existing Supabase (Recommended)

You already have Supabase configured. The ERIX-Store will use the same database:

```
DATABASE_URL=postgresql://postgres.bnchmgyybdsklxrumcnd:gZn79UnIYxAKBFys@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

### Option B: Create New Render Postgres

1. Go to Render Dashboard
2. Create New → PostgreSQL
3. Name: `erix-store-db`
4. Copy the connection string

The ERIX-Store will automatically create the `erix_snapshots` table on first boot.

---

## 🚀 Step 3: Deploy to Render

### Method A: One-Click Deploy (Recommended)

1. **Push to GitHub**:
   ```bash
   cd /Ubuntu/home/dhanesh/ecodrix/ECOD/erix-store
   git add .
   git commit -m "feat: ready for production deployment"
   git push origin main
   ```

2. **Deploy via Blueprint**:
   - Go to [render.com/blueprints](https://render.com/blueprints)
   - Click "New Blueprint Instance"
   - Connect your GitHub repository
   - Select the `ECOD/erix-store` directory
   - Render will detect `render.yaml` automatically

3. **Configure Environment Variables**:
   ```
   DATABASE_URL=postgresql://postgres.bnchmgyybdsklxrumcnd:gZn79UnIYxAKBFys@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
   ERIX_API_KEY=erix_19d13b9a9a9e72f0c9d65f2de05cdf70fa1b7b3d64d845b89f49f39501aedac3
   NODE_ENV=production
   PORT=6399
   ```

### Method B: Manual Deploy

1. **Create Web Service**:
   - Go to Render Dashboard
   - Create New → Web Service
   - Connect GitHub repository
   - Root Directory: `ECOD/erix-store`

2. **Configure Service**:
   - **Name**: `erix-store`
   - **Runtime**: Docker
   - **Dockerfile Path**: `./Dockerfile`
   - **Health Check Path**: `/health`
   - **Auto-Deploy**: Yes (on push to main)

3. **Set Environment Variables** (same as above)

---

## 🔗 Step 4: Get Production URL

After deployment, Render will provide a URL like:
```
https://erix-store-abc123.onrender.com
```

**Test the deployment**:
```bash
# Health check (no auth required)
curl https://erix-store-abc123.onrender.com/health

# Expected: {"status":"ok","uptime":123.45}
```

---

## ⚙️ Step 5: Update Server Configuration

Update your server's `.env` to use the production ERIX-Store:

```bash
# Edit ECOD/server/.env
cd /Ubuntu/home/dhanesh/ecodrix/ECOD/server
```

**Change these lines**:
```env
# FROM (localhost):
ERIX_STORE_URL=http://localhost:6399

# TO (production):
ERIX_STORE_URL=https://erix-store-abc123.onrender.com

# Keep the same API key:
ERIX_API_KEY=erix_19d13b9a9a9e72f0c9d65f2de05cdf70fa1b7b3d64d845b89f49f39501aedac3
ERIX_TENANT_ID=laie
```

---

## 🧪 Step 6: Test Production Integration

```bash
cd /Ubuntu/home/dhanesh/ecodrix/ECOD/server

# Test with production ERIX-Store
pnpm run test:session:quick
```

**Expected output**:
```
🚀 Quick Session Isolation Test

1️⃣  Testing ERIX-Store connection...
   ✅ Connected! Uptime: 123s

2️⃣  Testing SessionManager...
   ✅ Session created: session_...
   📍 IP: 35.202.1.1
   ...

🎉 All tests passed!
```

---

## 🔒 Step 7: Security Configuration

### Make ERIX-Store Internal (Recommended)

1. **Render Dashboard** → erix-store → Settings
2. **Visibility** → Private (Internal Service)
3. **Update server URL**:
   ```env
   # If using internal networking:
   ERIX_STORE_URL=http://erix-store:6399
   ```

### Keep Public (Easier Setup)

If you keep it public, ensure:
- Strong API key (64+ characters)
- Monitor access logs
- Consider IP allowlisting

---

## 📊 Step 8: Monitoring Setup

### Health Monitoring

Add to your uptime monitor:
```
URL: https://erix-store-abc123.onrender.com/health
Expected: 200 OK
Interval: 5 minutes
```

### Database Monitoring

Check snapshot freshness:
```sql
SELECT saved_at, NOW() - saved_at AS age
FROM erix_snapshots
WHERE label = 'main'
ORDER BY saved_at DESC
LIMIT 1;
```

Alert if `age > 10 minutes`.

### Application Logs

Monitor Render logs for:
- `[Persistence] Snapshot saved ✓` (every 5 minutes)
- `401 Unauthorized` (authentication issues)
- `Error:` (application errors)

---

## 🚨 Troubleshooting

### Deployment Issues

**Build fails**:
```bash
# Check Dockerfile syntax
cd ECOD/erix-store
docker build -t erix-store-test .
```

**Health check fails**:
- Verify `/health` endpoint returns 200
- Check `PORT` environment variable
- Ensure no authentication on health endpoint

### Connection Issues

**401 Unauthorized**:
- Verify `ERIX_API_KEY` matches in both services
- Check `x-erix-key` header is being sent

**Timeout/Connection refused**:
- Verify ERIX-Store URL (no trailing slash)
- Check Render service is running
- Test health endpoint directly

### Performance Issues

**Cold starts (free tier)**:
- Upgrade to Render Starter ($7/month)
- Add keep-alive ping from server

**Slow responses**:
- Check Render region (use same as server)
- Monitor PostgreSQL connection pool

---

## 💰 Cost Estimation

### Render Pricing

- **Free Tier**: $0/month (cold starts after 15min idle)
- **Starter**: $7/month (always on, 512MB RAM)
- **Standard**: $25/month (1GB RAM, better performance)

### Database Costs

- **Supabase Free**: $0/month (500MB, 2 connections)
- **Supabase Pro**: $25/month (8GB, 60 connections)
- **Render Postgres**: $7/month (1GB, 97 connections)

### Recommended Setup

**Development**: Free tier + Supabase Free = $0/month  
**Production**: Starter + Supabase Pro = $32/month

---

## 📝 Deployment Commands Summary

```bash
# 1. Generate API key
node -e "console.log('erix_' + require('crypto').randomBytes(32).toString('hex'))"

# 2. Push to GitHub
cd /Ubuntu/home/dhanesh/ecodrix/ECOD/erix-store
git add .
git commit -m "feat: production deployment ready"
git push origin main

# 3. Deploy on Render (via dashboard)
# - Connect GitHub repo
# - Use render.yaml blueprint
# - Set environment variables

# 4. Update server config
cd /Ubuntu/home/dhanesh/ecodrix/ECOD/server
# Edit .env with production URL

# 5. Test integration
pnpm run test:session:quick
```

---

## 🎯 Success Criteria

### ✅ Deployment Successful

- [ ] ERIX-Store deployed to Render
- [ ] Health check returns 200 OK
- [ ] PostgreSQL snapshots working (every 5 minutes)
- [ ] Server can connect to production ERIX-Store
- [ ] Session isolation tests pass with production URL

### ✅ Production Ready

- [ ] Strong API key configured
- [ ] Environment variables secured
- [ ] Monitoring setup (uptime + logs)
- [ ] Backup strategy for PostgreSQL
- [ ] Documentation updated with production URLs

---

## 🔄 Rollback Plan

If deployment fails:

1. **Revert server config**:
   ```env
   ERIX_STORE_URL=http://localhost:6399
   ```

2. **Start local ERIX-Store**:
   ```bash
   cd ECOD/erix-store
   npm start
   ```

3. **Test locally**:
   ```bash
   cd ECOD/server
   pnpm run test:session:quick
   ```

---

## 📞 Support

### Render Support
- [Render Docs](https://render.com/docs)
- [Render Community](https://community.render.com)
- Support tickets via dashboard

### ERIX-Store Issues
- Check `PRODUCTION.md` for troubleshooting
- Review Render logs for errors
- Test health endpoint directly

---

**Status**: Ready for production deployment! 🚀

**Next Steps**:
1. Generate API key
2. Push to GitHub  
3. Deploy via Render Blueprint
4. Update server configuration
5. Test production integration

**Estimated Time**: 30 minutes for full deployment and testing.