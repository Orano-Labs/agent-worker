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
ALTER TABLE `supervisor` ADD COLUMN `capacity` INTEGER NOT NULL DEFAULT 8,
    ADD COLUMN `remaining_capacity` INTEGER NOT NULL DEFAULT 8;

-- AlterTable
ALTER TABLE `template` DROP COLUMN `sourceTemplateId`,
    ADD COLUMN `source_template_id` VARCHAR(24) NULL;

-- CreateTable
CREATE TABLE `instance` (
    `id` VARCHAR(24) NOT NULL,
    `project_id` VARCHAR(24) NOT NULL,
    `supervisor_id` VARCHAR(24) NULL,
    `create_time` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `instance_project_id_key`(`project_id`),
    INDEX `instance_supervisor_id_idx`(`supervisor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `template` ADD CONSTRAINT `template_source_template_id_fkey` FOREIGN KEY (`source_template_id`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_template_id_fkey` FOREIGN KEY (`template_id`) REFERENCES `template`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instance` ADD CONSTRAINT `instance_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `instance` ADD CONSTRAINT `instance_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
