/*
  Warnings:

  - Made the column `supervisor_id` on table `instance` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE `instance` DROP FOREIGN KEY `instance_supervisor_id_fkey`;

-- AlterTable
ALTER TABLE `instance` ADD COLUMN `confirmed` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `supervisor_id` VARCHAR(24) NOT NULL;

-- AddForeignKey
ALTER TABLE `instance` ADD CONSTRAINT `instance_supervisor_id_fkey` FOREIGN KEY (`supervisor_id`) REFERENCES `supervisor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
