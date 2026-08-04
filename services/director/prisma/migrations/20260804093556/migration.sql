/*
  Warnings:

  - You are about to drop the column `templateId` on the `project` table. All the data in the column will be lost.
  - You are about to drop the column `sourceTemplateId` on the `template` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE `project` DROP FOREIGN KEY `project_templateId_fkey`;

-- DropForeignKey
ALTER TABLE `template` DROP FOREIGN KEY `template_sourceTemplateId_fkey`;

-- DropIndex
DROP INDEX `project_templateId_fkey` ON `project`;

-- DropIndex
DROP INDEX `template_sourceTemplateId_fkey` ON `template`;

-- AlterTable
ALTER TABLE `project` DROP COLUMN `templateId`,
    ADD COLUMN `template_id` VARCHAR(24) NULL;

-- AlterTable
ALTER TABLE `template` DROP COLUMN `sourceTemplateId`,
    ADD COLUMN `source_template_id` VARCHAR(24) NULL;

-- CreateTable
CREATE TABLE `dispatch` (
    `id` VARCHAR(24) NOT NULL,
    `project_id` VARCHAR(24) NOT NULL,
    `status` ENUM('PENDING', 'DISPATCHED', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `active_key` VARCHAR(24) NULL DEFAULT 'active',
    `supervisor_id` VARCHAR(24) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lease_token` VARCHAR(64) NOT NULL,
    `lease_until` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `update_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `dispatch_lease_token_key`(`lease_token`),
    INDEX `dispatch_project_id_status_idx`(`project_id`, `status`),
    INDEX `dispatch_status_lease_until_idx`(`status`, `lease_until`),
    INDEX `dispatch_supervisor_id_status_idx`(`supervisor_id`, `status`),
    UNIQUE INDEX `dispatch_project_id_active_key_key`(`project_id`, `active_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `template` ADD CONSTRAINT `template_source_template_id_fkey` FOREIGN KEY (`source_template_id`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dispatch` ADD CONSTRAINT `dispatch_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dispatch` ADD CONSTRAINT `dispatch_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
