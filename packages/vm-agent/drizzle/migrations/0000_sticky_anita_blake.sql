CREATE TABLE `sessions` (
	`create_timestamp` integer DEFAULT (unixepoch()) NOT NULL,
	`update_timestamp` integer DEFAULT (unixepoch()) NOT NULL,
	`id` text PRIMARY KEY NOT NULL
);
