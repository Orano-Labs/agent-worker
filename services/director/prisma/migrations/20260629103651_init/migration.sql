-- CreateTable
CREATE TABLE `user` (
    `id` VARCHAR(24) NOT NULL,
    `public_key` VARBINARY(128) NOT NULL,
    `metadata` VARBINARY(2048) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,
    `disabled` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `user_public_key_key`(`public_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supervisor` (
    `id` VARCHAR(24) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `public_key` VARBINARY(128) NOT NULL,
    `metadata` VARBINARY(2048) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,

    UNIQUE INDEX `supervisor_public_key_key`(`public_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project` (
    `id` VARCHAR(24) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(512) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,
    `resource_tier` ENUM('MINIMUM', 'STANDARD', 'PERFORMANCE') NOT NULL DEFAULT 'MINIMUM',
    `owner_id` VARCHAR(24) NOT NULL,
    `deployment_status` ENUM('PENDING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `deployment_error_message` VARCHAR(512) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template` (
    `id` VARCHAR(24) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(512) NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session` (
    `id` VARCHAR(24) NOT NULL,
    `projectId` VARCHAR(24) NOT NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `metadata` JSON NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `session_entry` (
    `id` VARCHAR(24) NOT NULL,
    `session_id` VARCHAR(24) NOT NULL,
    `data` LONGBLOB NOT NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sequence` INTEGER NOT NULL AUTO_INCREMENT,

    UNIQUE INDEX `session_entry_sequence_key`(`sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task` (
    `id` VARCHAR(24) NOT NULL,
    `type` ENUM('Steer', 'FllowUp') NOT NULL,
    `status` ENUM('Pending', 'Running', 'Success', 'Failed', 'Interrupted') NOT NULL,
    `session_id` VARCHAR(24) NOT NULL,
    `sequence` INTEGER NOT NULL AUTO_INCREMENT,

    UNIQUE INDEX `task_sequence_key`(`sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `run` (
    `id` VARCHAR(24) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `run_entry` (
    `id` VARCHAR(24) NOT NULL,
    `run_id` VARCHAR(24) NOT NULL,
    `data` LONGBLOB NOT NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sequence` INTEGER NOT NULL AUTO_INCREMENT,

    UNIQUE INDEX `run_entry_sequence_key`(`sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Outbox` (
    `id` VARCHAR(24) NOT NULL,
    `topic` VARCHAR(128) NOT NULL,
    `payload` LONGBLOB NOT NULL,
    `create_time` TIMESTAMP(3) NOT NULL,
    `trace_id` VARCHAR(100) NULL,
    `publish_time` TIMESTAMP(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `session` ADD CONSTRAINT `session_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `session_entry` ADD CONSTRAINT `session_entry_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task` ADD CONSTRAINT `task_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `run_entry` ADD CONSTRAINT `run_entry_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
