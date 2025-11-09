/**
 * Simple in-memory metrics tracking
 * For production, consider using Prometheus, StatsD, or similar
 */

interface MetricsCounts {
  totalValidations: number;
  totalSmtpValidations: number;
  smtpStatus: {
    valid: number;
    invalid: number;
    catch_all: number;
    temporarily_unavailable: number;
    unknown: number;
    not_checked: number;
    policy_rejection: number;
  };
}

class MetricsCollector {
  private metrics: MetricsCounts = {
    totalValidations: 0,
    totalSmtpValidations: 0,
    smtpStatus: {
      valid: 0,
      invalid: 0,
      catch_all: 0,
      temporarily_unavailable: 0,
      unknown: 0,
      not_checked: 0,
      policy_rejection: 0,
    },
  };

  /**
   * Increment total validations counter
   */
  incrementValidations(): void {
    this.metrics.totalValidations++;
  }

  /**
   * Increment SMTP validations counter and track status
   * Only counts actual SMTP attempts (not 'not_checked')
   */
  recordSmtpValidation(status: keyof MetricsCounts['smtpStatus']): void {
    // Only increment total if SMTP was actually attempted (not skipped)
    if (status !== 'not_checked') {
      this.metrics.totalSmtpValidations++;
    }
    
    if (status in this.metrics.smtpStatus) {
      this.metrics.smtpStatus[status]++;
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): MetricsCounts {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.metrics = {
      totalValidations: 0,
      totalSmtpValidations: 0,
      smtpStatus: {
        valid: 0,
        invalid: 0,
        catch_all: 0,
        temporarily_unavailable: 0,
        unknown: 0,
        not_checked: 0,
        policy_rejection: 0,
      },
    };
  }
}

export const metrics = new MetricsCollector();
