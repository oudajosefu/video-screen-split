use mdns_sd::{ServiceDaemon, ServiceInfo};
use tracing::{info, warn};

pub const SERVICE_TYPE: &str = "_video-screen-split._tcp.local.";

pub fn advertise(port: u16) -> anyhow::Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new()?;
    let host = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "coordinator".into());
    let instance_name = format!("coordinator-{host}");
    let host_fqdn = format!("{host}.local.");

    let ips: Vec<std::net::IpAddr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .map(|i| i.ip())
        .collect();

    let service = ServiceInfo::new(
        SERVICE_TYPE,
        &instance_name,
        &host_fqdn,
        &ips[..],
        port,
        None,
    )?;

    match daemon.register(service) {
        Ok(_) => info!(port, "mDNS service registered as {instance_name}"),
        Err(e) => warn!(?e, "mDNS registration failed; falling back to manual config"),
    }
    Ok(daemon)
}
