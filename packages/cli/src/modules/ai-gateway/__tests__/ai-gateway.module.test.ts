import { AiGatewayModule } from '../ai-gateway.module';

describe('AiGatewayModule', () => {
	it('tells the editor that the Gateway credits use the self-hosted gateway', async () => {
		expect(await new AiGatewayModule().settings()).toEqual({ selfHosted: true });
	});
});
