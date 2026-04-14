/**
 * BSC Operations — SignalR Negotiate
 *
 * Returns a SignalR connection URL + access token so the browser client
 * can connect to the Azure SignalR Service hub named "bscops".
 *
 * Route: GET /api/negotiate
 * Requires: AzureSignalRConnectionString env var set in Azure Static Web Apps
 */
module.exports = async function (context, req, connectionInfo) {
  context.res = {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store'
    },
    body: connectionInfo
  };
};
