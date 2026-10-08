-- AlterTable
ALTER TABLE `project` ADD COLUMN `supervisor_id` VARCHAR(24) NULL,
    ADD COLUMN `workspace` VARCHAR(1024) NOT NULL DEFAULT '/';

-- AlterTable
ALTER TABLE `supervisor` ADD COLUMN `owner_id` VARCHAR(24) NULL;

-- AddForeignKey
ALTER TABLE `supervisor` ADD CONSTRAINT `supervisor_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project` ADD CONSTRAINT `project_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
