/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IAuthenticationService } from '../../../authentication/common/authentication';
import { CopilotToken } from '../../../authentication/common/copilotToken';
import { IHeaders } from '../../../networking/common/fetcherService';
import { Emitter } from '../../../util/vs/base/common/event';
import { CopilotUserQuotaInfo, IChatQuotaService } from '../../common/chatQuotaService';
import { ChatQuotaService } from '../../common/chatQuotaServiceImpl';

describe('ChatQuotaService timezone handling', () => {
	let quotaService: IChatQuotaService;
	let mockAuthService: IAuthenticationService;
	let mockToken: CopilotToken;
	let onDidAuthenticationChangeEmitter: Emitter<void>;

	beforeEach(() => {
		onDidAuthenticationChangeEmitter = new Emitter<void>();
		
		// Create a minimal mock auth service
		mockAuthService = {
			_serviceBrand: undefined,
			isMinimalMode: false,
			onDidAuthenticationChange: onDidAuthenticationChangeEmitter.event,
			copilotToken: undefined
		} as any;

		// Mock the copilot token
		mockToken = {
			isFreeUser: false,
			quotaInfo: undefined
		} as any;

		// Set up the auth service to return our mock token
		Object.defineProperty(mockAuthService, 'copilotToken', {
			get: () => mockToken,
			configurable: true
		});
		
		quotaService = new ChatQuotaService(mockAuthService);
	});

	it('should reset usage when current time has passed reset date and usage appears stale', () => {
		// Simulate current time being after October 1st (reset date)
		const currentTime = new Date('2024-10-01T08:00:00Z');
		vi.setSystemTime(currentTime);

		const quotaInfo: CopilotUserQuotaInfo = {
			quota_reset_date: '2024-10-01T00:00:00Z', // Reset at midnight UTC (8 hours ago)
			quota_snapshots: {
				premium_interactions: {
					quota_id: 'test-quota',
					entitlement: 100,
					remaining: 20, // Only 20% remaining - looks like stale data from previous month
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 20
				},
				chat: {
					quota_id: 'test-chat-quota',
					entitlement: 100,
					remaining: 50,
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 50
				},
				completions: {
					quota_id: 'test-completions-quota',
					entitlement: 100,
					remaining: 30,
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 30
				}
			}
		};

		// Mock the token to return this quota info
		Object.defineProperty(mockToken, 'quotaInfo', {
			get: () => quotaInfo,
			configurable: true
		});
		
		// Trigger quota processing by calling the private method directly
		(quotaService as any).processUserInfoQuotaSnapshot(quotaInfo);

		// The usage should be 0 since we're past reset date and usage appears stale
		const quotaInfoFromService = (quotaService as any)._quotaInfo;
		expect(quotaInfoFromService).toBeDefined();
		expect(quotaInfoFromService.used).toBe(0); // Should be reset to 0
		expect(quotaInfoFromService.quota).toBe(100);
	});

	it('should use normal calculation when before reset date', () => {
		// Simulate current time being before October 1st reset
		const currentTime = new Date('2024-09-30T21:00:00Z');
		vi.setSystemTime(currentTime);

		const quotaInfo: CopilotUserQuotaInfo = {
			quota_reset_date: '2024-10-01T00:00:00Z', // Reset in 3 hours
			quota_snapshots: {
				premium_interactions: {
					quota_id: 'test-quota',
					entitlement: 100,
					remaining: 20,
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 20 // 20% remaining = 80% used
				},
				chat: {
					quota_id: 'test-chat-quota',
					entitlement: 100,
					remaining: 50,
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 50
				},
				completions: {
					quota_id: 'test-completions-quota',
					entitlement: 100,
					remaining: 30,
					unlimited: false,
					overage_count: 0,
					overage_permitted: false,
					percent_remaining: 30
				}
			}
		};

		Object.defineProperty(mockToken, 'quotaInfo', {
			get: () => quotaInfo,
			configurable: true
		});
		
		// Trigger quota processing
		(quotaService as any).processUserInfoQuotaSnapshot(quotaInfo);

		// The usage should be 80 (80% of 100) - normal calculation
		const quotaInfoFromService = (quotaService as any)._quotaInfo;
		expect(quotaInfoFromService).toBeDefined();
		expect(quotaInfoFromService.used).toBe(80);
	});

	it('should handle quota headers with timezone reset logic', () => {
		// Simulate current time being after reset date
		const currentTime = new Date('2024-10-01T08:00:00Z');
		vi.setSystemTime(currentTime);

		// Create mock headers that suggest high usage from previous month
		const mockHeaders: IHeaders = new Map([
			['x-quota-snapshot-premium_interactions', 'ent=100&rem=20.0&ov=0.0&ovPerm=false&rst=2024-10-01T00:00:00Z']
		]);

		// Process the headers
		quotaService.processQuotaHeaders(mockHeaders);

		// Since we're past the reset date and usage appears high (80%), should reset to 0
		const quotaInfoFromService = (quotaService as any)._quotaInfo;
		expect(quotaInfoFromService).toBeDefined();
		expect(quotaInfoFromService.used).toBe(0); // Should be reset to 0
		expect(quotaInfoFromService.quota).toBe(100);
	});

	it('should use normal calculation when past reset date but usage is low', () => {
		// Simulate current time being after reset date
		const currentTime = new Date('2024-10-01T08:00:00Z');
		vi.setSystemTime(currentTime);

		// Create mock headers with low usage (suggests server data is current)
		const mockHeaders: IHeaders = new Map([
			['x-quota-snapshot-premium_interactions', 'ent=100&rem=90.0&ov=0.0&ovPerm=false&rst=2024-10-01T00:00:00Z']
		]);

		quotaService.processQuotaHeaders(mockHeaders);

		// Since usage is low (10%), server data is likely current - use normal calculation
		const quotaInfoFromService = (quotaService as any)._quotaInfo;
		expect(quotaInfoFromService).toBeDefined();
		expect(quotaInfoFromService.used).toBe(10); // 10% of 100
	});
});
});