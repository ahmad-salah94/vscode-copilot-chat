/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IHeaders } from '../../networking/common/fetcherService';
import { CopilotUserQuotaInfo, IChatQuota, IChatQuotaService } from './chatQuotaService';

export class ChatQuotaService extends Disposable implements IChatQuotaService {
	declare readonly _serviceBrand: undefined;
	private _quotaInfo: IChatQuota | undefined;

	constructor(@IAuthenticationService private readonly _authService: IAuthenticationService) {
		super();
		this._register(this._authService.onDidAuthenticationChange(() => {
			this.processUserInfoQuotaSnapshot(this._authService.copilotToken?.quotaInfo);
		}));
	}

	get quotaExhausted(): boolean {
		if (!this._quotaInfo) {
			return false;
		}
		return this._quotaInfo.used >= this._quotaInfo.quota && !this._quotaInfo.overageEnabled && !this._quotaInfo.unlimited;
	}

	get overagesEnabled(): boolean {
		if (!this._quotaInfo) {
			return false;
		}
		return this._quotaInfo.overageEnabled;
	}

	clearQuota(): void {
		this._quotaInfo = undefined;
	}

	processQuotaHeaders(headers: IHeaders): void {
		const quotaHeader = this._authService.copilotToken?.isFreeUser ? headers.get('x-quota-snapshot-chat') : headers.get('x-quota-snapshot-premium_models') || headers.get('x-quota-snapshot-premium_interactions');
		if (!quotaHeader) {
			return;
		}

		try {
			// Parse URL encoded string into key-value pairs
			const params = new URLSearchParams(quotaHeader);

			// Extract values with fallbacks to ensure type safety
			const entitlement = parseInt(params.get('ent') || '0', 10);
			const overageUsed = parseFloat(params.get('ov') || '0.0');
			const overageEnabled = params.get('ovPerm') === 'true';
			const percentRemaining = parseFloat(params.get('rem') || '0.0');
			const resetDateString = params.get('rst');

			let resetDate: Date;
			if (resetDateString) {
				resetDate = new Date(resetDateString);
			} else {
				// Default to one month from now if not provided
				resetDate = new Date();
				resetDate.setMonth(resetDate.getMonth() + 1);
			}

			// Calculate used based on entitlement and remaining, accounting for quota period resets
			const used = this.calculateUsedQuota(entitlement, percentRemaining, resetDate);

			// Update quota info
			this._quotaInfo = {
				quota: entitlement,
				unlimited: entitlement === -1,
				used,
				overageUsed,
				overageEnabled,
				resetDate
			};
		} catch (error) {
			console.error('Failed to parse quota header', error);
		}
	}

	private processUserInfoQuotaSnapshot(quotaInfo: CopilotUserQuotaInfo | undefined) {
		if (!quotaInfo || !quotaInfo.quota_snapshots || !quotaInfo.quota_reset_date) {
			return;
		}
		
		const resetDate = new Date(quotaInfo.quota_reset_date);
		const entitlement = quotaInfo.quota_snapshots.premium_interactions.entitlement;
		const percentRemaining = quotaInfo.quota_snapshots.premium_interactions.percent_remaining;
		
		// Calculate used quota, accounting for quota period resets
		const used = this.calculateUsedQuota(entitlement, percentRemaining, resetDate);
		
		this._quotaInfo = {
			unlimited: quotaInfo.quota_snapshots.premium_interactions.unlimited,
			overageEnabled: quotaInfo.quota_snapshots.premium_interactions.overage_permitted,
			overageUsed: quotaInfo.quota_snapshots.premium_interactions.overage_count,
			quota: entitlement,
			resetDate,
			used,
		};
	}

	/**
	 * Calculate used quota, accounting for quota period resets due to timezone differences.
	 * If the current time has passed the reset date, and the percent_remaining suggests
	 * usage from a previous period, adjust the calculation accordingly.
	 */
	private calculateUsedQuota(entitlement: number, percentRemaining: number, resetDate: Date): number {
		const now = new Date();
		
		// If we haven't reached the reset date yet, use normal calculation
		if (now <= resetDate) {
			return Math.max(0, entitlement * (1 - percentRemaining / 100));
		}
		
		// We've passed the reset date - check if quota data looks like it's from previous period
		// If percent_remaining is very low (< 50%), it might be stale data from previous month
		// In a new quota period right after reset, we'd expect percent_remaining to be close to 100%
		const normalUsed = Math.max(0, entitlement * (1 - percentRemaining / 100));
		const usageRatio = normalUsed / entitlement;
		
		// If usage ratio is high (> 50%) and we're past reset date, likely showing stale data
		// Reset to 0 as we're in a new quota period
		if (usageRatio > 0.5) {
			console.debug(`Copilot quota: Detected stale usage data (${Math.round(usageRatio * 100)}% used) after reset date (${resetDate.toISOString()}). Resetting to 0 for new quota period.`);
			return 0;
		}
		
		// Otherwise, use the normal calculation (server data is up to date)
		return normalUsed;
	}
}