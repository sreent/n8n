// The module's only public entry. The shell imports the descriptor from here via
// `modules.manifest.ts`; anything else the shell (or a test) needs must be exported
// here too — deep paths into `src/` are not part of the contract.
export { AiGatewayModule } from './ai-gateway.module';
export { AI_GATEWAY_ADMIN_VIEW } from './ai-gateway.constants';
export { useAiGatewayAdminStore } from './ai-gateway-admin.store';
