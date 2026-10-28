
CREATE DATABASE [EWarehouseDB];
GO
USE [EWarehouseDB];
GO

CREATE TABLE dbo.[roles] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(20) NOT NULL,
    [role_name] NVARCHAR(64) NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_roles_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_roles_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_roles_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_roles] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_roles_code] UNIQUE NONCLUSTERED ([code])
);
GO

CREATE TABLE dbo.[users] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [username] NVARCHAR(64) NOT NULL,
    [password] NVARCHAR(64) NOT NULL,
    [email] NVARCHAR(64) NULL,
    [name] NVARCHAR(64) NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_users_status] DEFAULT ((1)),
    [role_id] INT NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_users_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_users_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_users] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_users_username] UNIQUE NONCLUSTERED ([username]),
    CONSTRAINT [FK_users_role_id] FOREIGN KEY ([role_id]) REFERENCES dbo.[roles] ([id])
);
GO

CREATE TABLE dbo.[partners] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [name] NVARCHAR(64) NOT NULL,
    [phone_number] NVARCHAR(10) NULL,
    [address] NVARCHAR(192) NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_partners_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_partners_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_partners_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_partners] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_partners_code] UNIQUE NONCLUSTERED ([code])
);
GO

CREATE TABLE dbo.[base_units] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [description] NVARCHAR(192) NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_base_units_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_base_units_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_base_units_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_base_units] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_base_units_code] UNIQUE NONCLUSTERED ([code])
);
GO

CREATE TABLE dbo.[warehouses] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [name] NVARCHAR(64) NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_warehouses_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_warehouses_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_warehouses_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_warehouses] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_warehouses_code] UNIQUE NONCLUSTERED ([code])
);
GO

CREATE TABLE dbo.[bins] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [location_id] NVARCHAR(24) NOT NULL,
    [warehouse_id] INT NOT NULL,
    [description] NVARCHAR(192) NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_bins_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_bins_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_bins_updated_at] DEFAULT (getdate()),
    [max_capacity] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_bins_max_capacity] DEFAULT ((5000)),
    CONSTRAINT [PK_bins] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [CK_bins_max_capacity_positive] CHECK ([max_capacity]>(0)),
    CONSTRAINT [FK_bins_warehouse_id] FOREIGN KEY ([warehouse_id]) REFERENCES dbo.[warehouses] ([id])
);
GO

CREATE TABLE dbo.[items] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [name] NVARCHAR(64) NOT NULL,
    [base_unit_id] INT NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_items_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_items_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_items_updated_at] DEFAULT (getdate()),
    [forecast_enabled] BIT NOT NULL CONSTRAINT [DF_items_forecast_enabled] DEFAULT ((0)),
    CONSTRAINT [PK_items] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_items_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [FK_items_base_unit_id] FOREIGN KEY ([base_unit_id]) REFERENCES dbo.[base_units] ([id])
);
GO

CREATE TABLE dbo.[goods_receipts] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [order_date] DATE NOT NULL,
    [warehouse_id] INT NOT NULL,
    [partner_id] INT NOT NULL,
    [user_id] INT NOT NULL,
    [description] NVARCHAR(192) NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_goods_receipts_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_receipts_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_receipts_updated_at] DEFAULT (getdate()),
    [lifecycle_status] VARCHAR(16) NOT NULL CONSTRAINT [DF_goods_receipts_lifecycle_status] DEFAULT ('Active'),
    [activated_at] DATETIME2(7) NULL,
    [completed_at] DATETIME2(7) NULL,
    [completed_by] INT NULL,
    [revision_no] INT NOT NULL CONSTRAINT [DF_goods_receipts_revision_no] DEFAULT ((0)),
    [request_key] UNIQUEIDENTIFIER NULL,
    [request_hash] VARCHAR(64) NULL,
    CONSTRAINT [CK_goods_receipts_state] CHECK ([lifecycle_status] IN ('Active','Completed','Cancelled')),
    CONSTRAINT [PK_goods_receipts] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_goods_receipts_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [FK_goods_receipts_completed_by] FOREIGN KEY ([completed_by]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_goods_receipts_partner_id] FOREIGN KEY ([partner_id]) REFERENCES dbo.[partners] ([id]),
    CONSTRAINT [FK_goods_receipts_user_id] FOREIGN KEY ([user_id]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_goods_receipts_warehouse_id] FOREIGN KEY ([warehouse_id]) REFERENCES dbo.[warehouses] ([id])
);
GO

CREATE TABLE dbo.[goods_receipt_details] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [goods_receipt_id] INT NOT NULL,
    [item_id] INT NOT NULL,
    [quantity_ordered] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_goods_receipt_details_quantity_ordered] DEFAULT ((0)),
    [unit_price] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_goods_receipt_details_unit_price] DEFAULT ((0)),
    [bin_id] INT NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_receipt_details_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_receipt_details_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_goods_receipt_details] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FK_goods_receipt_details_bin_id] FOREIGN KEY ([bin_id]) REFERENCES dbo.[bins] ([id]),
    CONSTRAINT [FK_goods_receipt_details_item_id] FOREIGN KEY ([item_id]) REFERENCES dbo.[items] ([id]),
    CONSTRAINT [FK_goods_receipt_details_goods_receipt_id] FOREIGN KEY ([goods_receipt_id]) REFERENCES dbo.[goods_receipts] ([id])
);
GO

CREATE TABLE dbo.[goods_issues] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [order_date] DATE NOT NULL,
    [warehouse_id] INT NOT NULL,
    [partner_id] INT NOT NULL,
    [user_id] INT NOT NULL,
    [status] BIT NOT NULL CONSTRAINT [DF_goods_issues_status] DEFAULT ((1)),
    [description] NVARCHAR(192) NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_issues_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_issues_updated_at] DEFAULT (getdate()),
    [lifecycle_status] VARCHAR(16) NOT NULL CONSTRAINT [DF_goods_issues_lifecycle_status] DEFAULT ('Draft'),
    [activated_at] DATETIME2(7) NULL,
    [completed_at] DATETIME2(7) NULL,
    [completed_by] INT NULL,
    [revision_no] INT NOT NULL CONSTRAINT [DF_goods_issues_revision_no] DEFAULT ((0)),
    [request_key] UNIQUEIDENTIFIER NULL,
    [request_hash] VARCHAR(64) NULL,
    CONSTRAINT [CK_goods_issues_state] CHECK ([lifecycle_status] IN ('Draft','Active','Completed','Cancelled')),
    CONSTRAINT [PK_goods_issues] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_goods_issues_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [FK_goods_issues_completed_by] FOREIGN KEY ([completed_by]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_goods_issues_partner_id] FOREIGN KEY ([partner_id]) REFERENCES dbo.[partners] ([id]),
    CONSTRAINT [FK_goods_issues_user_id] FOREIGN KEY ([user_id]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_goods_issues_warehouse_id] FOREIGN KEY ([warehouse_id]) REFERENCES dbo.[warehouses] ([id])
);
GO

CREATE TABLE dbo.[goods_issue_details] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [goods_issue_id] INT NOT NULL,
    [item_id] INT NOT NULL,
    [quantity_ordered] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_goods_issue_details_quantity_ordered] DEFAULT ((0)),
    [unit_price] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_goods_issue_details_unit_price] DEFAULT ((0)),
    [bin_id] INT NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_issue_details_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_goods_issue_details_updated_at] DEFAULT (getdate()),
    [reserved_quantity] DECIMAL(18,2) NOT NULL CONSTRAINT [DF_goods_issue_details_reserved_quantity] DEFAULT ((0)),
    CONSTRAINT [PK_goods_issue_details] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FK_goods_issue_details_bin_id] FOREIGN KEY ([bin_id]) REFERENCES dbo.[bins] ([id]),
    CONSTRAINT [FK_goods_issue_details_goods_issue_id] FOREIGN KEY ([goods_issue_id]) REFERENCES dbo.[goods_issues] ([id]),
    CONSTRAINT [FK_goods_issue_details_item_id] FOREIGN KEY ([item_id]) REFERENCES dbo.[items] ([id])
);
GO

CREATE TABLE dbo.[inventory_checks] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [from_date] DATE NOT NULL,
    [to_date] DATE NOT NULL,
    [warehouse_id] INT NOT NULL,
    [user_id] INT NOT NULL,
    [description] NVARCHAR(192) NULL,
    [check_status] NVARCHAR(64) NOT NULL CONSTRAINT [DF_inventory_checks_check_status] DEFAULT (N'InProgress'),
    [status] BIT NOT NULL CONSTRAINT [DF_inventory_checks_status] DEFAULT ((1)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_inventory_checks_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_inventory_checks_updated_at] DEFAULT (getdate()),
    [completed_at] DATETIME2(7) NULL,
    [cancelled_at] DATETIME2(7) NULL,
    CONSTRAINT [CK_inventory_checks_state] CHECK ([check_status] IN ('InProgress','Completed','Cancelled')),
    CONSTRAINT [PK_inventory_checks] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_inventory_checks_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [FK_inventory_checks_user_id] FOREIGN KEY ([user_id]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_inventory_checks_warehouse_id] FOREIGN KEY ([warehouse_id]) REFERENCES dbo.[warehouses] ([id])
);
GO

CREATE TABLE dbo.[inventory_check_details] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [inventory_check_id] INT NOT NULL,
    [check_detail_code] NVARCHAR(24) NOT NULL,
    [item_id] INT NOT NULL,
    [bin_id] INT NOT NULL,
    [actual_quantity] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_inventory_check_details_actual_quantity] DEFAULT ((0)),
    [book_quantity] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_inventory_check_details_book_quantity] DEFAULT ((0)),
    [discrepancy] NUMERIC(18,2) NOT NULL CONSTRAINT [DF_inventory_check_details_discrepancy] DEFAULT ((0)),
    [discrepancy_handled] BIT NOT NULL CONSTRAINT [DF_inventory_check_details_discrepancy_handled] DEFAULT ((0)),
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_inventory_check_details_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_inventory_check_details_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_inventory_check_details] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [FK_inventory_check_details_bin_id] FOREIGN KEY ([bin_id]) REFERENCES dbo.[bins] ([id]),
    CONSTRAINT [FK_inventory_check_details_inventory_check_id] FOREIGN KEY ([inventory_check_id]) REFERENCES dbo.[inventory_checks] ([id]),
    CONSTRAINT [FK_inventory_check_details_item_id] FOREIGN KEY ([item_id]) REFERENCES dbo.[items] ([id])
);
GO

CREATE TABLE dbo.[stock_movements] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(64) NOT NULL,
    [sequence_no] INT NOT NULL,
    [operation_kind] VARCHAR(12) NOT NULL,
    [goods_receipt_id] INT NULL,
    [goods_issue_id] INT NULL,
    [operation_date] DATE NOT NULL,
    [operation_status] VARCHAR(12) NOT NULL CONSTRAINT [DF_stock_movements_operation_status] DEFAULT ('Pending'),
    [user_id] INT NOT NULL,
    [confirmed_by] INT NULL,
    [confirmed_at] DATETIME2(7) NULL,
    [rejected_at] DATETIME2(7) NULL,
    [reason] NVARCHAR(192) NULL,
    [description] NVARCHAR(192) NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_stock_movements_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_stock_movements_updated_at] DEFAULT (getdate()),
    [source_document_id] INT NULL,
    [request_key] UNIQUEIDENTIFIER NOT NULL,
    [request_hash] VARCHAR(64) NOT NULL,
    CONSTRAINT [PK_stock_movements] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_stock_movements_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [UQ_stock_movements_request_key] UNIQUE NONCLUSTERED ([request_key]),
    CONSTRAINT [CK_stock_movements_1] CHECK ([operation_status]='Cancelled' OR [operation_status]='Rejected' OR [operation_status]='Confirmed' OR [operation_status]='Pending'),
    CONSTRAINT [CK_stock_movements_2] CHECK ([goods_receipt_id] IS NOT NULL AND [goods_issue_id] IS NULL OR [goods_receipt_id] IS NULL AND [goods_issue_id] IS NOT NULL),
    CONSTRAINT [CK_stock_movements_kind] CHECK ([operation_kind]='ISSUE' OR [operation_kind]='RECEIPT'),
    CONSTRAINT [CK_stock_movements_kind_document] CHECK ([operation_kind]='RECEIPT' AND [goods_receipt_id] IS NOT NULL OR [operation_kind]='ISSUE' AND [goods_issue_id] IS NOT NULL),
    CONSTRAINT [FK_stock_movements_confirmed_by] FOREIGN KEY ([confirmed_by]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_stock_movements_goods_receipt_id] FOREIGN KEY ([goods_receipt_id]) REFERENCES dbo.[goods_receipts] ([id]),
    CONSTRAINT [FK_stock_movements_goods_issue_id] FOREIGN KEY ([goods_issue_id]) REFERENCES dbo.[goods_issues] ([id]),
    CONSTRAINT [FK_stock_movements_user_id] FOREIGN KEY ([user_id]) REFERENCES dbo.[users] ([id])
);
GO

CREATE TABLE dbo.[stock_movement_details] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [stock_movement_id] INT NOT NULL,
    [goods_receipt_detail_id] INT NULL,
    [goods_issue_detail_id] INT NULL,
    [item_id] INT NOT NULL,
    [bin_id] INT NOT NULL,
    [quantity] DECIMAL(18,2) NOT NULL,
    [paid_quantity] DECIMAL(18,2) NOT NULL,
    [bonus_quantity] DECIMAL(18,2) NOT NULL CONSTRAINT [DF_stock_movement_details_bonus_quantity] DEFAULT ((0)),
    [unit_price] DECIMAL(18,2) NOT NULL,
    [inventory_value] DECIMAL(18,2) NOT NULL,
    [cost_price] DECIMAL(18,2) NOT NULL CONSTRAINT [DF_stock_movement_details_cost_price] DEFAULT ((0)),
    [source_detail_id] INT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_stock_movement_details_created_at] DEFAULT (getdate()),
    [updated_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_stock_movement_details_updated_at] DEFAULT (getdate()),
    CONSTRAINT [PK_stock_movement_details] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_stock_movement_details_stock_movement_id_item_id_bin_id] UNIQUE NONCLUSTERED ([stock_movement_id], [item_id], [bin_id]),
    CONSTRAINT [CK_stock_movement_details_1] CHECK ([bonus_quantity]>=(0)),
    CONSTRAINT [CK_stock_movement_details_2] CHECK ([inventory_value]>=(0)),
    CONSTRAINT [CK_stock_movement_details_3] CHECK ([paid_quantity]>=(0)),
    CONSTRAINT [CK_stock_movement_details_4] CHECK ([quantity]>(0)),
    CONSTRAINT [CK_stock_movement_details_5] CHECK ([unit_price]>=(0)),
    CONSTRAINT [CK_stock_movement_details_6] CHECK ([goods_receipt_detail_id] IS NOT NULL AND [goods_issue_detail_id] IS NULL OR [goods_receipt_detail_id] IS NULL AND [goods_issue_detail_id] IS NOT NULL),
    CONSTRAINT [CK_stock_movement_details_7] CHECK ([quantity]=([paid_quantity]+[bonus_quantity])),
    CONSTRAINT [FK_stock_movement_details_bin_id] FOREIGN KEY ([bin_id]) REFERENCES dbo.[bins] ([id]),
    CONSTRAINT [FK_stock_movement_details_goods_receipt_detail_id] FOREIGN KEY ([goods_receipt_detail_id]) REFERENCES dbo.[goods_receipt_details] ([id]),
    CONSTRAINT [FK_stock_movement_details_goods_issue_detail_id] FOREIGN KEY ([goods_issue_detail_id]) REFERENCES dbo.[goods_issue_details] ([id]),
    CONSTRAINT [FK_stock_movement_details_item_id] FOREIGN KEY ([item_id]) REFERENCES dbo.[items] ([id]),
    CONSTRAINT [FK_stock_movement_details_stock_movement_id] FOREIGN KEY ([stock_movement_id]) REFERENCES dbo.[stock_movements] ([id])
);
GO

CREATE TABLE dbo.[payments] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [code] NVARCHAR(24) NOT NULL,
    [partner_id] INT NOT NULL,
    [user_id] INT NOT NULL,
    [direction] VARCHAR(3) NOT NULL,
    [purpose] VARCHAR(12) NOT NULL,
    [security_action] VARCHAR(8) NULL,
    [amount] DECIMAL(18,2) NOT NULL,
    [payment_date] DATE NOT NULL,
    [method] NVARCHAR(32) NOT NULL,
    [note] NVARCHAR(192) NULL,
    [refund_of_id] INT NULL,
    [request_key] UNIQUEIDENTIFIER NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_payments_created_at] DEFAULT (getdate()),
    [request_hash] VARCHAR(64) NULL,
    [goods_receipt_id] INT NULL,
    [goods_issue_id] INT NULL,
    [sequence_no] INT NULL,
    [operation_status] VARCHAR(12) NOT NULL CONSTRAINT [DF_payments_operation_status] DEFAULT ('Pending'),
    [confirmed_by] INT NULL,
    [confirmed_at] DATETIME2(7) NULL,
    [rejected_at] DATETIME2(7) NULL,
    [reason] NVARCHAR(192) NULL,
    CONSTRAINT [PK_payments] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_payments_code] UNIQUE NONCLUSTERED ([code]),
    CONSTRAINT [UQ_payments_request_key] UNIQUE NONCLUSTERED ([request_key]),
    CONSTRAINT [CK_payments_1] CHECK ([amount]>(0)),
    CONSTRAINT [CK_payments_2] CHECK ([direction]='OUT' OR [direction]='IN'),
    CONSTRAINT [CK_payments_3] CHECK ([purpose]='REFUND' OR [purpose]='SECURITY' OR [purpose]='ADVANCE' OR [purpose]='PAYMENT'),
    CONSTRAINT [CK_payments_security_action] CHECK ([security_action] IS NULL OR ([purpose]='SECURITY' AND [operation_status]='Confirmed' AND [security_action] IN ('KEEP','APPLY'))),
    CONSTRAINT [CK_payment_document] CHECK ([goods_receipt_id] IS NOT NULL AND [goods_issue_id] IS NULL OR [goods_receipt_id] IS NULL AND [goods_issue_id] IS NOT NULL),
    CONSTRAINT [CK_payment_state] CHECK ([operation_status]='Cancelled' OR [operation_status]='Rejected' OR [operation_status]='Confirmed' OR [operation_status]='Pending'),
    CONSTRAINT [FK_payments_confirmed_by] FOREIGN KEY ([confirmed_by]) REFERENCES dbo.[users] ([id]),
    CONSTRAINT [FK_payments_goods_receipt_id] FOREIGN KEY ([goods_receipt_id]) REFERENCES dbo.[goods_receipts] ([id]),
    CONSTRAINT [FK_payments_goods_issue_id] FOREIGN KEY ([goods_issue_id]) REFERENCES dbo.[goods_issues] ([id]),
    CONSTRAINT [FK_payments_partner_id] FOREIGN KEY ([partner_id]) REFERENCES dbo.[partners] ([id]),
    CONSTRAINT [FK_payments_refund_of_id] FOREIGN KEY ([refund_of_id]) REFERENCES dbo.[payments] ([id]),
    CONSTRAINT [FK_payments_user_id] FOREIGN KEY ([user_id]) REFERENCES dbo.[users] ([id])
);
GO

CREATE TABLE dbo.[daily_demand_history] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [demand_date] DATE NOT NULL,
    [opening_inventory] DECIMAL(18,4) NOT NULL,
    [units_sold] DECIMAL(18,4) NOT NULL,
    [received_quantity] DECIMAL(18,4) NOT NULL,
    [adjustment_quantity] DECIMAL(18,4) NOT NULL,
    [closing_inventory] DECIMAL(18,4) NOT NULL,
    [item_id] INT NOT NULL,
    [warehouse_id] INT NOT NULL,
    [created_at] DATETIME2(7) NOT NULL CONSTRAINT [DF_daily_demand_history_created_at] DEFAULT (sysutcdatetime()),
    CONSTRAINT [PK_daily_demand_history] PRIMARY KEY CLUSTERED ([id]),
    CONSTRAINT [UQ_daily_demand_history_demand_date_item_id_warehouse_id] UNIQUE NONCLUSTERED ([demand_date], [item_id], [warehouse_id]),
    CONSTRAINT [CK_daily_demand_history_balance] CHECK (abs(((([opening_inventory]+[received_quantity])+[adjustment_quantity])-[units_sold])-[closing_inventory])<=(0.0001)),
    CONSTRAINT [CK_daily_demand_history_values] CHECK ([opening_inventory]>=(0) AND [units_sold]>=(0) AND [received_quantity]>=(0) AND [closing_inventory]>=(0)),
    CONSTRAINT [FK_daily_demand_history_item_id] FOREIGN KEY ([item_id]) REFERENCES dbo.[items] ([id]),
    CONSTRAINT [FK_daily_demand_history_warehouse_id] FOREIGN KEY ([warehouse_id]) REFERENCES dbo.[warehouses] ([id])
);
GO

CREATE UNIQUE NONCLUSTERED INDEX [UX_receipt_request] ON dbo.[goods_receipts] ([request_key]) WHERE ([request_key] IS NOT NULL);
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_issue_request] ON dbo.[goods_issues] ([request_key]) WHERE ([request_key] IS NOT NULL);
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_movement_issue] ON dbo.[stock_movements] ([goods_issue_id], [operation_kind], [sequence_no]) WHERE ([goods_issue_id] IS NOT NULL);
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_movement_receipt] ON dbo.[stock_movements] ([goods_receipt_id], [operation_kind], [sequence_no]) WHERE ([goods_receipt_id] IS NOT NULL);
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_payment_issue] ON dbo.[payments] ([goods_issue_id], [sequence_no]) WHERE ([goods_issue_id] IS NOT NULL);
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_payment_receipt] ON dbo.[payments] ([goods_receipt_id], [sequence_no]) WHERE ([goods_receipt_id] IS NOT NULL);
GO
CREATE NONCLUSTERED INDEX [IX_daily_demand_history_series_date] ON dbo.[daily_demand_history] ([warehouse_id], [item_id], [demand_date]) INCLUDE ([units_sold], [closing_inventory]);
GO

CREATE VIEW dbo.issue_transaction_details AS
 SELECT d.id,d.stock_movement_id goods_issue_id,d.goods_issue_detail_id root_detail_id,d.item_id,d.bin_id,d.quantity quantity_ordered,
 d.unit_price,d.cost_price,d.created_at,d.updated_at,
 COALESCE(d.source_detail_id,d.id+100000000) ledger_line_id
 FROM dbo.stock_movement_details d JOIN dbo.stock_movements m ON m.id=d.stock_movement_id WHERE m.operation_kind='ISSUE';
GO

CREATE VIEW dbo.issue_transactions AS
 SELECT m.id,m.goods_issue_id root_id,m.code,m.operation_date order_date,h.warehouse_id,h.partner_id,m.user_id,m.description,
 m.operation_status issue_status,h.status,m.created_at,m.updated_at,m.confirmed_at,m.rejected_at,
 COALESCE(m.source_document_id,m.id+100000000) ledger_order_id
 FROM dbo.stock_movements m JOIN dbo.goods_issues h ON h.id=m.goods_issue_id WHERE m.operation_kind='ISSUE';
GO

CREATE VIEW dbo.receipt_transaction_details AS
 SELECT d.id,d.stock_movement_id goods_receipt_id,d.goods_receipt_detail_id root_detail_id,d.item_id,d.bin_id,d.quantity quantity_ordered,
 CAST(CASE WHEN d.quantity=0 THEN 0 ELSE d.inventory_value/d.quantity END AS DECIMAL(18,2)) unit_price,
 d.unit_price commercial_unit_price,d.inventory_value,d.paid_quantity,d.bonus_quantity,d.created_at,d.updated_at,
 COALESCE(d.source_detail_id,d.id+100000000) ledger_line_id
 FROM dbo.stock_movement_details d JOIN dbo.stock_movements m ON m.id=d.stock_movement_id WHERE m.operation_kind='RECEIPT';
GO

CREATE VIEW dbo.receipt_transactions AS
 SELECT m.id,m.goods_receipt_id root_id,m.code,m.operation_date order_date,h.warehouse_id,h.partner_id,m.user_id,m.description,
 m.operation_status receipt_status, h.status,m.created_at,m.updated_at,m.confirmed_at,m.rejected_at,
 COALESCE(m.source_document_id,m.id+100000000) ledger_order_id
 FROM dbo.stock_movements m JOIN dbo.goods_receipts h ON h.id=m.goods_receipt_id WHERE m.operation_kind='RECEIPT';
GO

CREATE VIEW dbo.weekly_demand_history
AS
WITH dated_rows AS (
    SELECT
        h.id,
        h.demand_date,
        CAST(DATEADD(DAY, -(DATEDIFF(DAY, CONVERT(date, '19000101', 112), h.demand_date) % 7), h.demand_date) AS date) AS week_start,
        h.opening_inventory,
        h.units_sold,
        h.received_quantity,
        h.adjustment_quantity,
        h.closing_inventory,
        h.item_id,
        h.warehouse_id
    FROM dbo.daily_demand_history h
), ranked_rows AS (
    SELECT
        d.*,
        ROW_NUMBER() OVER (
            PARTITION BY d.item_id, d.warehouse_id, d.week_start
            ORDER BY d.demand_date, d.id
        ) AS first_row_number,
        ROW_NUMBER() OVER (
            PARTITION BY d.item_id, d.warehouse_id, d.week_start
            ORDER BY d.demand_date DESC, d.id DESC
        ) AS last_row_number
    FROM dated_rows d
), weekly_rows AS (
    SELECT
        r.week_start,
        DATEADD(DAY, 6, r.week_start) AS week_end,
        r.item_id,
        r.warehouse_id,
        MAX(CASE WHEN r.first_row_number = 1 THEN r.opening_inventory END) AS opening_inventory,
        SUM(r.units_sold) AS units_sold,
        SUM(r.received_quantity) AS received_quantity,
        SUM(r.adjustment_quantity) AS adjustment_quantity,
        MAX(CASE WHEN r.last_row_number = 1 THEN r.closing_inventory END) AS closing_inventory,
        COUNT_BIG(*) AS calendar_day_count,
        SUM(CASE WHEN r.units_sold = 0 THEN 1 ELSE 0 END) AS zero_demand_day_count,
        SUM(CASE WHEN r.opening_inventory = 0 OR r.closing_inventory = 0 THEN 1 ELSE 0 END) AS stockout_day_count,
        SUM(CASE WHEN r.opening_inventory < 0 OR r.closing_inventory < 0 THEN 1 ELSE 0 END) AS negative_inventory_day_count,
        SUM(CASE
            WHEN ABS((r.opening_inventory + r.received_quantity + r.adjustment_quantity - r.units_sold) - r.closing_inventory) > 0.0001
            THEN 1 ELSE 0
        END) AS balance_error_day_count,
        MIN(r.demand_date) AS first_demand_date,
        MAX(r.demand_date) AS last_demand_date
    FROM ranked_rows r
    GROUP BY r.item_id, r.warehouse_id, r.week_start
)
SELECT
    w.week_start,
    w.week_end,
    w.item_id,
    w.warehouse_id,
    CAST(w.opening_inventory AS decimal(18,4)) AS opening_inventory,
    CAST(w.units_sold AS decimal(18,4)) AS units_sold,
    CAST(w.received_quantity AS decimal(18,4)) AS received_quantity,
    CAST(w.adjustment_quantity AS decimal(18,4)) AS adjustment_quantity,
    CAST(w.closing_inventory AS decimal(18,4)) AS closing_inventory,
    CAST(w.calendar_day_count AS int) AS calendar_day_count,
    CAST(w.zero_demand_day_count AS int) AS zero_demand_day_count,
    CAST(w.stockout_day_count AS int) AS stockout_day_count,
    CAST(CASE
        WHEN w.calendar_day_count = 7
         AND w.first_demand_date = w.week_start
         AND w.last_demand_date = w.week_end
        THEN 1 ELSE 0
    END AS bit) AS is_complete_week,
    CAST(CASE
        WHEN w.item_id IS NOT NULL
         AND w.warehouse_id IS NOT NULL
         AND w.calendar_day_count = 7
         AND w.first_demand_date = w.week_start
         AND w.last_demand_date = w.week_end
         AND w.negative_inventory_day_count = 0
         AND w.balance_error_day_count = 0
        THEN 1 ELSE 0
    END AS bit) AS is_training_eligible
FROM weekly_rows w;
GO
