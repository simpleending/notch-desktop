use serde::Deserialize;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND, IDXGIFactory1,
};
use wmi::WMIConnection;

#[derive(Deserialize)]
struct PhysicalMemory {
    #[serde(rename = "Capacity")]
    capacity: u64,
}

#[derive(Deserialize)]
struct GpuMemory {
    #[serde(rename = "DedicatedUsage")]
    dedicated_usage: u64,
}

fn installed_memory(rows: &[PhysicalMemory]) -> Result<u64, &'static str> {
    if rows.is_empty() {
        return Err("Installed memory telemetry is unavailable.");
    }
    rows.iter().try_fold(0u64, |sum, row| {
        sum.checked_add(row.capacity)
            .ok_or("Installed memory overflow.")
    })
}

fn dedicated_usage(rows: &[GpuMemory]) -> Result<u64, &'static str> {
    // Match the existing maximum across adapter counters; never treat missing usage as zero.
    rows.iter()
        .map(|row| row.dedicated_usage)
        .max()
        .ok_or("GPU usage telemetry is unavailable.")
}

fn largest_dedicated_memory() -> windows::core::Result<u64> {
    // The generated COM wrappers release factory/adapter references on every return path.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut largest = 0;
        for index in 0..32 {
            let adapter = match factory.EnumAdapters1(index) {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error),
            };
            let desc = adapter.GetDesc1()?;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0 {
                largest = largest.max(desc.DedicatedVideoMemory as u64);
            }
        }
        Ok(largest)
    }
}

fn query() -> Result<(u64, u64, u64), Box<dyn std::error::Error>> {
    let connection = WMIConnection::new()?;
    let gpu: Vec<GpuMemory> = connection.raw_query("SELECT DedicatedUsage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory")?;
    let ram: Vec<PhysicalMemory> =
        connection.raw_query("SELECT Capacity FROM Win32_PhysicalMemory")?;
    Ok((
        installed_memory(&ram)?,
        largest_dedicated_memory()?,
        dedicated_usage(&gpu)?,
    ))
}

fn main() {
    match query() {
        Ok((installed, dedicated, used)) => println!(
            "{{\"schemaVersion\":1,\"installedMemory\":{installed},\"dedicatedMemory\":{dedicated},\"dedicatedUsage\":{used}}}"
        ),
        Err(error) => {
            eprintln!("Windows memory telemetry failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_64_bit_capacities_and_maximum_usage() {
        assert_eq!(
            installed_memory(&[
                PhysicalMemory { capacity: 16 << 30 },
                PhysicalMemory { capacity: 16 << 30 }
            ]),
            Ok(32 << 30)
        );
        assert_eq!(
            dedicated_usage(&[
                GpuMemory {
                    dedicated_usage: 5 << 30
                },
                GpuMemory {
                    dedicated_usage: 7 << 30
                }
            ]),
            Ok(7 << 30)
        );
        assert_eq!(dedicated_usage(&[GpuMemory { dedicated_usage: 0 }]), Ok(0));
    }

    #[test]
    fn missing_or_overflowing_telemetry_is_not_free_memory() {
        assert!(installed_memory(&[]).is_err());
        assert!(dedicated_usage(&[]).is_err());
        assert!(
            installed_memory(&[
                PhysicalMemory { capacity: u64::MAX },
                PhysicalMemory { capacity: 1 }
            ])
            .is_err()
        );
    }
}
