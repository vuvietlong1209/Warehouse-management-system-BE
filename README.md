# E-Warehouse — Backend

API Node.js/Express, SQL Server


## Cài đặt và cấu hình

```powershell
npm ci
Copy-Item .env.example .env
```

Chỉnh `.env`: `DB_SERVER`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `FRONTEND_URL`. Đặt `JWT_SECRET` thành khóa ngẫu nhiên riêng tối thiểu 32 ký tự, không dùng chuỗi mẫu. Có thể tạo khóa bằng:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Database

### Máy mới với database mới hoàn toàn

1. Mở SSMS, chạy `database/schema.sql`.
2. Nếu cần dữ liệu demo, chạy `database/seed.sql`
3. Cấu hình `.env` trỏ tới database vừa tạo, rồi chạy:

```powershell
npm run db:migrate
```
## Chạy hệ thống

Phát triển:

```powershell
npm run dev
```

Production, sau khi cấu hình hạ tầng HTTPS/reverse proxy phù hợp:

```powershell
$env:NODE_ENV = 'production'
npm start
```

BE là JavaScript chạy trực tiếp, **không có bước `npm run build`**. Có thể dùng `npm ci --omit=dev` trên máy chỉ chạy production; khi đó không có nodemon cho lệnh dev.

Kiểm tra sức khỏe tại `http://localhost:4000/health`. API tại `/api`. Frontend gọi qua proxy `/api` của Next.js. Khi triển khai thật, dùng HTTPS vì cookie phiên có cờ Secure trong production.

