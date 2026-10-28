
USE [EWarehouseDB];
GO
SET XACT_ABORT ON;
BEGIN TRANSACTION;
GO

-- 1. Roles
INSERT INTO [roles] ([code], [role_name], [status]) VALUES 
(N'ADMIN', N'Quản trị hệ thống', 1),
(N'MANAGER', N'Quản lý kho', 1),
(N'STAFF', N'Nhân viên kho', 1);
GO

-- 2. Users
INSERT INTO [users] ([username], [password], [email], [name], [status], [role_id]) VALUES 
(N'admin', N'$2a$10$hhBtWmKkKnmf3eI55q3jJu8sqHxDMeP57GotinsEwOb5Oys8yeuQi', N'admin@ewarehouse.com', N'Admin User', 1, 1),
(N'nhanvien1', N'$2a$10$wyJ6lMkGkF2aJ2N9IsVGaOR0xqL1qdHY6/2kwMMxUmzFFBojSqLyK', N'nv1@ewarehouse.com', N'Nguyễn Văn A', 1, 3),
(N'quanly1', N'$2a$10$wyJ6lMkGkF2aJ2N9IsVGaOR0xqL1qdHY6/2kwMMxUmzFFBojSqLyK', N'ql1@ewarehouse.com', N'Trần Thị B', 1, 2);
GO

-- 3. Partners (Nhà cung cấp & Khách hàng)
INSERT INTO [partners] ([code], [name], [phone_number], [address], [status]) VALUES
(N'NCC-SAMSUNG', N'Công ty TNHH Samsung Electronics VN', N'0901234567', N'KCN Yên Phong, Bắc Ninh', 1),
(N'NCC-INTEL', N'Nhà phân phối Intel Việt Nam', N'0912345678', N'Tầng 12, Bitexco, Q.1, TP.HCM', 1),
(N'NCC-NVIDIA', N'Đại lý Chính hãng NVIDIA VN', N'0923456789', N'Quận Cầu Giấy, Hà Nội', 1),
(N'KH-GEARVN', N'Chuỗi Cửa hàng GearVN', N'0934567890', N'Quận 10, TP.HCM', 1),
(N'KH-ANPHAT', N'Công ty Máy tính An Phát', N'0945678901', N'Quận Đống Đa, Hà Nội', 1);
GO

-- 4. Base Units (Đơn vị tính)
INSERT INTO [base_units] ([code], [description], [status]) VALUES
(N'Cai', N'Cái / Chiếc đơn lẻ', 1),
(N'Bo', N'Bộ linh kiện / Kit', 1),
(N'Hop', N'Hộp nguyên seal', 1),
(N'Thung', N'Thùng đóng gói nhà máy', 1);
GO

-- 5. Warehouses
INSERT INTO [warehouses] ([code], [name], [status]) VALUES
(N'KHO-HN', N'Kho Tổng Hà Nội - Cầu Giấy', 1),
(N'KHO-HCM', N'Kho Chi nhánh TP.HCM - Q.9', 1),
(N'KHO-DN', N'Kho Miền Trung - Đà Nẵng', 1);
GO

-- 6. Bins (Vị trí kho)
INSERT INTO [bins] ([location_id], [warehouse_id], [description], [max_capacity], [status]) VALUES
(N'101', 1, N'Khu A - Kệ 01 - Ô 01 (Linh kiện CPU/RAM)', 5000, 1),
(N'102', 1, N'Khu A - Kệ 01 - Ô 02 (Ổ cứng SSD/HDD)', 5000, 1),
(N'103', 1, N'Khu B - Kệ 02 - Ô 01 (VGA & Mainboard)', 5000, 1),
(N'104', 1, N'Khu C - Kệ 03 - Ô 01 (Màn hình & Case)', 5000, 1),
(N'201', 2, N'Kho HCM - Kệ A1', 5000, 1);
GO

-- 7. Items (Sản phẩm điện tử)
INSERT INTO [items] ([code], [name], [base_unit_id], [status]) VALUES
(N'SP-SSD1TB',  N'SSD 1TB NVMe Gen4',                1, 1),
(N'SP-RAM16G',  N'RAM 16GB DDR5 5600MHz',            1, 1),
(N'SP-MH24IN',  N'Màn hình 24" IPS 144Hz',           1, 1),
(N'SP-CQ01',    N'Chuột quang Gaming Wireless',      1, 1),
(N'SP-PBC01',   N'Bàn phím cơ RGB Mechanical',       1, 1),
(N'SP-RTX4090', N'VGA RTX 4090 24GB Gaming',         1, 1),
(N'SP-MBX570',  N'Mainboard X570 Chipset AMD',       1, 1),
(N'SP-NGUON1K', N'Nguồn 1000W 80 Plus Gold',         1, 1),
(N'SP-TNWC',    N'Tản nhiệt nước AIO 360mm',         1, 1),
(N'SP-CASEFT',  N'Case Full Tower Tempered Glass',   1, 1),
(N'SP-DELLX15', N'Dell XPS 15 Motherboard',          1, 1),
(N'SP-SAM2TB',  N'Samsung 2TB NVMe SSD',             1, 1),
(N'SP-INTELI9', N'Intel Core i9 Processors 14900K',  1, 1);
GO

-- 8. Phiếu nhập kho mẫu
INSERT INTO [goods_receipts] ([code], [order_date], [warehouse_id], [partner_id], [user_id], [description], [activated_at]) VALUES
(N'PO-2023-001', '2023-10-15', 1, 1, 1, N'Nhập kho lô SSD và RAM mới từ Samsung', '2023-10-15 09:00:00');
GO

-- Chi tiết phiếu nhập
INSERT INTO [goods_receipt_details] ([goods_receipt_id], [item_id], [quantity_ordered], [unit_price], [bin_id]) VALUES
(1, 1,  1200, 1800000, 2),  -- SSD 1TB
(1, 2,   950, 1200000, 1),  -- RAM 16GB
(1, 3,   800, 3200000, 4),  -- Màn hình 24"
(1, 4,   650,  450000, 1),  -- Chuột quang
(1, 5,   500,  850000, 1),  -- Bàn phím cơ
(1, 6,    42, 42000000, 3), -- RTX 4090: sau khi xuất 12 còn 30 để kiểm kê
(1, 11,  150, 4500000, 3),  -- Dell XPS 15 Motherboard
(1, 12,  500, 3400000, 2),  -- Samsung 2TB NVMe
(1, 13,  100, 13000000, 1); -- Intel Core i9: sau khi xuất 50 còn 50
GO

-- 9. Phiếu xuất kho mẫu
INSERT INTO [goods_issues] ([code], [order_date], [warehouse_id], [partner_id], [user_id], [description], [activated_at]) VALUES
(N'SO-2023-001', '2023-10-20', 1, 4, 1, N'Xuất hàng đợt 1 cho hệ thống đại lý GearVN', '2023-10-20 10:30:00');
GO

INSERT INTO [goods_issue_details] ([goods_issue_id], [item_id], [quantity_ordered], [unit_price], [bin_id]) VALUES
(1, 1,  200, 2200000, 2),   -- SSD 1TB
(1, 6,   12, 48000000, 3), -- RTX 4090
(1, 13,  50, 14500000, 1); -- Intel Core i9
GO

-- 10. Kiểm kê kho mẫu
INSERT INTO [inventory_checks] ([code], [from_date], [to_date], [warehouse_id], [user_id], [description], [check_status]) VALUES
(N'KK-2023-10', '2023-10-24', '2023-10-24', 1, 1, N'Kiểm kê định kỳ tháng 10/2023', N'Completed');
GO

INSERT INTO [inventory_check_details] ([inventory_check_id], [check_detail_code], [item_id], [bin_id], [actual_quantity], [book_quantity], [discrepancy], [discrepancy_handled]) VALUES
(1, N'KKCT-01', 1, 2, 1000, 1000,  0, 1),  -- SSD 1TB khớp
(1, N'KKCT-02', 6, 3,   28,   30, -2, 1);  -- RTX 4090 lệch -2
GO

INSERT dbo.stock_movements
    (code,sequence_no,operation_kind,goods_receipt_id,operation_date,operation_status,
     user_id,confirmed_by,confirmed_at,source_document_id,request_key,request_hash)
SELECT code,1,'RECEIPT',id,order_date,'Confirmed',user_id,user_id,activated_at,id,NEWID(),'demo-seed'
FROM dbo.goods_receipts;

INSERT dbo.stock_movements
    (code,sequence_no,operation_kind,goods_issue_id,operation_date,operation_status,
     user_id,confirmed_by,confirmed_at,source_document_id,request_key,request_hash)
SELECT code,1,'ISSUE',id,order_date,'Confirmed',user_id,user_id,activated_at,id,NEWID(),'demo-seed'
FROM dbo.goods_issues;

INSERT dbo.stock_movement_details
    (stock_movement_id,goods_receipt_detail_id,item_id,bin_id,quantity,paid_quantity,
     unit_price,inventory_value,source_detail_id)
SELECT m.id,d.id,d.item_id,d.bin_id,d.quantity_ordered,d.quantity_ordered,
    d.unit_price,d.quantity_ordered*d.unit_price,d.id
FROM dbo.goods_receipt_details d JOIN dbo.stock_movements m ON m.goods_receipt_id=d.goods_receipt_id;

INSERT dbo.stock_movement_details
    (stock_movement_id,goods_issue_detail_id,item_id,bin_id,quantity,paid_quantity,
     unit_price,inventory_value,cost_price,source_detail_id)
SELECT m.id,d.id,d.item_id,d.bin_id,d.quantity_ordered,d.quantity_ordered,
    d.unit_price,d.quantity_ordered*d.unit_price,
    (SELECT SUM(r.inventory_value)/NULLIF(SUM(r.quantity_ordered),0) FROM dbo.receipt_transaction_details r JOIN dbo.receipt_transactions h ON h.id=r.goods_receipt_id
     WHERE r.item_id=d.item_id AND h.warehouse_id=root.warehouse_id AND h.receipt_status='Confirmed' AND h.order_date<=m.operation_date),d.id
FROM dbo.goods_issue_details d JOIN dbo.stock_movements m ON m.goods_issue_id=d.goods_issue_id JOIN dbo.goods_issues root ON root.id=d.goods_issue_id;

INSERT dbo.payments
    (code,partner_id,user_id,direction,purpose,amount,payment_date,method,request_key,
     request_hash,goods_receipt_id,sequence_no,operation_status,confirmed_by,confirmed_at)
SELECT 'DEMO-PO-P01',h.partner_id,h.user_id,'OUT','PAYMENT',SUM(d.quantity_ordered*d.unit_price),
    h.order_date,N'Chuyển khoản',NEWID(),'demo-seed',h.id,1,'Confirmed',h.user_id,h.activated_at
FROM dbo.goods_receipts h JOIN dbo.goods_receipt_details d ON d.goods_receipt_id=h.id
GROUP BY h.id,h.partner_id,h.user_id,h.order_date,h.activated_at;

INSERT dbo.payments
    (code,partner_id,user_id,direction,purpose,amount,payment_date,method,request_key,
     request_hash,goods_issue_id,sequence_no,operation_status,confirmed_by,confirmed_at)
SELECT 'DEMO-SO-P01',h.partner_id,h.user_id,'IN','PAYMENT',SUM(d.quantity_ordered*d.unit_price),
    h.order_date,N'Chuyển khoản',NEWID(),'demo-seed',h.id,1,'Confirmed',h.user_id,h.activated_at
FROM dbo.goods_issues h JOIN dbo.goods_issue_details d ON d.goods_issue_id=h.id
GROUP BY h.id,h.partner_id,h.user_id,h.order_date,h.activated_at;

UPDATE dbo.goods_receipts SET lifecycle_status='Completed',completed_at=activated_at,completed_by=user_id;
UPDATE dbo.goods_issues SET lifecycle_status='Completed',completed_at=activated_at,completed_by=user_id;
UPDATE dbo.inventory_checks SET completed_at=CAST(to_date AS datetime2) WHERE check_status='Completed';
COMMIT TRANSACTION;
GO
