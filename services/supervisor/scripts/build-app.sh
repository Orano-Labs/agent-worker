pnpm install && pnpm --filter @aw/vm-runner build && rm -rf ./resources/app && pnpm --filter @aw/vm-runner deploy ./resources/app --prod --legacy --node-linker=hoisted
