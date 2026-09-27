let cachedCronJob = null;
let lastFetchTime = 0;

export async function getCronJobStatus(env = process.env, { fetchFn = globalThis.fetch } = {}) {
  const apiKey = env.CRONJOB_API_KEY;
  if (!apiKey) {
    return null;
  }

  const now = Date.now();
  if (cachedCronJob && (now - lastFetchTime < 30000)) {
    return cachedCronJob;
  }

  try {
    const res = await fetchFn('https://api.cron-job.org/jobs', {
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      return cachedCronJob;
    }
    const data = await res.json();
    const job = (data.jobs || []).find(j => j.url && j.url.includes('/api/cron')) || (data.jobs || [])[0];
    if (!job) {
      return cachedCronJob;
    }

    cachedCronJob = {
      jobId: job.jobId,
      enabled: job.enabled,
      title: job.title,
      nextExecution: job.nextExecution ? job.nextExecution * 1000 : null,
      lastExecution: job.lastExecution ? job.lastExecution * 1000 : null,
      lastStatus: job.lastStatus,
      lastDuration: job.lastDuration
    };
    lastFetchTime = now;
    return cachedCronJob;
  } catch {
    return cachedCronJob;
  }
}