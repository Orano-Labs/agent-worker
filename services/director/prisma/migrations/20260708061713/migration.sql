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
    `public_key` VARBINARY(128) NOT NULL,
    `metadata` VARBINARY(2048) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,

    UNIQUE INDEX `supervisor_public_key_key`(`public_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template` (
    `id` VARCHAR(24) NOT NULL,
    `metadata` VARBINARY(2048) NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,
    `sourceTemplateId` VARCHAR(24) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project` (
    `id` VARCHAR(24) NOT NULL,
    `metadata` VARBINARY(2048) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `delete_time` TIMESTAMP(3) NULL,
    `resource_tier` ENUM('MINIMUM', 'STANDARD', 'PERFORMANCE') NOT NULL DEFAULT 'MINIMUM',
    `owner_id` VARCHAR(24) NOT NULL,
    `templateId` VARCHAR(24) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `template` ADD CONSTRAINT `template_sourceTemplateId_fkey` FOREIGN KEY (`sourceTemplateId`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
