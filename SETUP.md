# Erix Store - Setup Guide

## 🔧 Quick Fix for TypeScript Errors

If you're seeing "Cannot find module 'express'" errors, follow these steps:

### 1. Install Dependencies

```bash
cd ECOD/erix-store
npm install
```

### 2. Verify Installation

```bash
# Check if express is installed
ls node_modules/express

# Check if @types/express is installed
ls node_modules/@types/express
```

### 3. Reload VS Code

Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) and run:
```
TypeScript: Reload Project
```

Or simply restart VS Code.

### 4. Build the Project

```bash
npm run build
```

If the build succeeds, the TypeScript configuration is correct.

---

## 🚀 Running the Server

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm run build
npm start
```

---

## 🧪 Testing the Setup

### 1. Start the Server

```bash
npm run dev
```

You should see:
```
[ErixStore] Connected to MongoDB
🚀 ErixStore running on http://localhost:6399
📊 Features enabled:
   - Advanced Job Queue (Priority, Delays, DLQ)
   - Distributed Locks (Mutex, RW, Semaphore)
   - Intelligent Cache (LRU, Tag-based)
   - Pub/Sub Messaging
   - Rate Limiting
```

### 2. Test Health Endpoint

```bash
curl http://localhost:6399/health
```

Expected response:
```json
{
  "status": "ok",
  "uptime": 123.456
}
```

### 3. Test Queue API

```bash
curl -X POST http://localhost:6399/queue/v2/test-queue/jobs \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: test" \
  -d '{
    "data": {"message": "Hello World"},
    "priority": 8
  }'
```

### 4. Test Lock API

```bash
curl -X POST http://localhost:6399/lock/acquire \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: test" \
  -d '{
    "key": "test-lock",
    "ttl": 30000
  }'
```

### 5. Test Cache API

```bash
curl -X POST http://localhost:6399/cache/test-key \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: test" \
  -d '{
    "value": {"test": true},
    "ttl": 3600000
  }'
```

---

## 🐛 Troubleshooting

### Issue: "Cannot find module 'express'"

**Solution 1: Reinstall node_modules**
```bash
rm -rf node_modules package-lock.json
npm install
```

**Solution 2: Check TypeScript version**
```bash
npx tsc --version
```

Should be 5.4.5 or higher.

**Solution 3: Reload VS Code**
- Press `Ctrl+Shift+P`
- Type "Reload Window"
- Press Enter

### Issue: MongoDB Connection Error

**Solution:**
1. Make sure MongoDB is running:
   ```bash
   mongosh
   ```

2. Update `.env` file:
   ```env
   MONGODB_URI=mongodb://localhost:27017/erix-store
   ```

3. Or use MongoDB Atlas:
   ```env
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/erix-store
   ```

### Issue: Port Already in Use

**Solution:**
1. Change port in `.env`:
   ```env
   PORT=6400
   ```

2. Or kill the process using port 6399:
   ```bash
   # Find process
   lsof -i :6399
   
   # Kill process
   kill -9 <PID>
   ```

### Issue: Build Errors

**Solution:**
```bash
# Clean build
rm -rf dist
npm run build

# Check for TypeScript errors
npx tsc --noEmit
```

---

## 📁 Project Structure

```
erix-store/
├── src/
│   ├── services/
│   │   ├── JobQueueV2.ts          ✅ Advanced job queue
│   │   ├── DistributedLock.ts     ✅ Distributed locking
│   │   ├── CacheService.ts        ✅ Intelligent cache
│   │   ├── JobQueue.ts            (legacy)
│   │   ├── PubSub.ts
│   │   └── RateLimiter.ts
│   ├── server/
│   │   ├── app.ts                 ✅ Updated with new routes
│   │   ├── routes/
│   │   │   ├── queueV2.routes.ts  ✅ Queue API
│   │   │   ├── lock.routes.ts     ✅ Lock API
│   │   │   ├── cache.routes.ts    ✅ Cache API
│   │   │   └── ... (existing)
│   │   └── middleware/
│   ├── core/
│   ├── structures/
│   └── index.ts                   ✅ Bootstrap
├── dist/                          (compiled output)
├── node_modules/
├── .env
├── package.json
├── tsconfig.json
└── README.md
```

---

## ✅ Verification Checklist

- [ ] Dependencies installed (`npm install`)
- [ ] MongoDB running
- [ ] `.env` file configured
- [ ] TypeScript compiles (`npm run build`)
- [ ] Server starts (`npm run dev`)
- [ ] Health endpoint responds
- [ ] Queue API works
- [ ] Lock API works
- [ ] Cache API works

---

## 🔄 If All Else Fails

### Complete Reset

```bash
# 1. Clean everything
rm -rf node_modules package-lock.json dist

# 2. Reinstall
npm install

# 3. Rebuild
npm run build

# 4. Start fresh
npm run dev
```

### Check Node Version

```bash
node --version
```

Should be 18.0.0 or higher.

### Check npm Version

```bash
npm --version
```

Should be 9.0.0 or higher.

---

## 📞 Still Having Issues?

1. **Check the logs** - Look for error messages in the console
2. **Verify MongoDB** - Make sure it's running and accessible
3. **Check firewall** - Ensure port 6399 is not blocked
4. **Review .env** - Verify all environment variables are set

---

## 🎉 Success!

If you see this output, everything is working:

```
[ErixStore] Connected to MongoDB
🚀 ErixStore running on http://localhost:6399
📊 Features enabled:
   - Advanced Job Queue (Priority, Delays, DLQ)
   - Distributed Locks (Mutex, RW, Semaphore)
   - Intelligent Cache (LRU, Tag-based)
   - Pub/Sub Messaging
   - Rate Limiting
```

**You're ready to start using Erix Store!** 🚀

---

## 📚 Next Steps

1. Read `README.md` for API documentation
2. Read `QUICKSTART.md` for usage examples
3. Read `INTEGRATION.md` for backend integration
4. Start building!

---

**Need help? Check the documentation or contact the Infrastructure Team.**
