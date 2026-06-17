import { Agent } from "undici";
import { createClient, createConfig } from "./firecracker/client";
import {
  createSnapshot,
  createSyncAction,
  describeBalloonConfig,
  describeBalloonHinting,
  describeBalloonStats,
  describeInstance,
  getExportVmConfig,
  getFirecrackerVersion,
  getMachineConfiguration,
  getMemoryHotplug,
  getMmds,
  loadSnapshot,
  patchBalloon,
  patchBalloonStatsInterval,
  patchGuestDriveById,
  patchGuestNetworkInterfaceById,
  patchGuestPmemById,
  patchMachineConfiguration,
  patchMemoryHotplug,
  patchMmds,
  patchVm,
  putBalloon,
  putCpuConfiguration,
  putEntropyDevice,
  putGuestBootSource,
  putGuestDriveById,
  putGuestNetworkInterfaceById,
  putGuestPmemById,
  putGuestVsock,
  putLogger,
  putMachineConfiguration,
  putMemoryHotplug,
  putMetrics,
  putMmds,
  putMmdsConfig,
  putSerialDevice,
  startBalloonHinting,
  stopBalloonHinting,
} from "./firecracker/sdk.gen";
import type {
  ArmRegisterModifier as FirecrackerArmRegisterModifier,
  Balloon as FirecrackerBalloon,
  BalloonHintingStatus as FirecrackerBalloonHintingStatus,
  BalloonStartCmd as FirecrackerBalloonStartCmd,
  BalloonStats as FirecrackerBalloonStats,
  BalloonStatsUpdate as FirecrackerBalloonStatsUpdate,
  BalloonUpdate as FirecrackerBalloonUpdate,
  BootSource as FirecrackerBootSource,
  ClientOptions as FirecrackerClientOptions,
  CpuConfig as FirecrackerCpuConfig,
  CpuidLeafModifier as FirecrackerCpuidLeafModifier,
  CpuidRegisterModifier as FirecrackerCpuidRegisterModifier,
  CpuTemplate as FirecrackerCpuTemplate,
  CreateSnapshotData as FirecrackerCreateSnapshotData,
  CreateSnapshotError as FirecrackerCreateSnapshotError,
  CreateSnapshotErrors as FirecrackerCreateSnapshotErrors,
  CreateSnapshotResponses as FirecrackerCreateSnapshotResponses,
  CreateSyncActionData as FirecrackerCreateSyncActionData,
  CreateSyncActionError as FirecrackerCreateSyncActionError,
  CreateSyncActionErrors as FirecrackerCreateSyncActionErrors,
  CreateSyncActionResponses as FirecrackerCreateSyncActionResponses,
  DescribeBalloonConfigData as FirecrackerDescribeBalloonConfigData,
  DescribeBalloonConfigError as FirecrackerDescribeBalloonConfigError,
  DescribeBalloonConfigErrors as FirecrackerDescribeBalloonConfigErrors,
  DescribeBalloonConfigResponse as FirecrackerDescribeBalloonConfigResponse,
  DescribeBalloonConfigResponses as FirecrackerDescribeBalloonConfigResponses,
  DescribeBalloonHintingData as FirecrackerDescribeBalloonHintingData,
  DescribeBalloonHintingError as FirecrackerDescribeBalloonHintingError,
  DescribeBalloonHintingErrors as FirecrackerDescribeBalloonHintingErrors,
  DescribeBalloonHintingResponse as FirecrackerDescribeBalloonHintingResponse,
  DescribeBalloonHintingResponses as FirecrackerDescribeBalloonHintingResponses,
  DescribeBalloonStatsData as FirecrackerDescribeBalloonStatsData,
  DescribeBalloonStatsError as FirecrackerDescribeBalloonStatsError,
  DescribeBalloonStatsErrors as FirecrackerDescribeBalloonStatsErrors,
  DescribeBalloonStatsResponse as FirecrackerDescribeBalloonStatsResponse,
  DescribeBalloonStatsResponses as FirecrackerDescribeBalloonStatsResponses,
  DescribeInstanceData as FirecrackerDescribeInstanceData,
  DescribeInstanceError as FirecrackerDescribeInstanceError,
  DescribeInstanceErrors as FirecrackerDescribeInstanceErrors,
  DescribeInstanceResponse as FirecrackerDescribeInstanceResponse,
  DescribeInstanceResponses as FirecrackerDescribeInstanceResponses,
  Drive as FirecrackerDrive,
  EntropyDevice as FirecrackerEntropyDevice,
  Error as FirecrackerError,
  FirecrackerVersion as FirecrackerFirecrackerVersion,
  FullVmConfiguration as FirecrackerFullVmConfiguration,
  GetExportVmConfigData as FirecrackerGetExportVmConfigData,
  GetExportVmConfigError as FirecrackerGetExportVmConfigError,
  GetExportVmConfigErrors as FirecrackerGetExportVmConfigErrors,
  GetExportVmConfigResponse as FirecrackerGetExportVmConfigResponse,
  GetExportVmConfigResponses as FirecrackerGetExportVmConfigResponses,
  GetFirecrackerVersionData as FirecrackerGetFirecrackerVersionData,
  GetFirecrackerVersionError as FirecrackerGetFirecrackerVersionError,
  GetFirecrackerVersionErrors as FirecrackerGetFirecrackerVersionErrors,
  GetFirecrackerVersionResponse as FirecrackerGetFirecrackerVersionResponse,
  GetFirecrackerVersionResponses as FirecrackerGetFirecrackerVersionResponses,
  GetMachineConfigurationData as FirecrackerGetMachineConfigurationData,
  GetMachineConfigurationError as FirecrackerGetMachineConfigurationError,
  GetMachineConfigurationErrors as FirecrackerGetMachineConfigurationErrors,
  GetMachineConfigurationResponse as FirecrackerGetMachineConfigurationResponse,
  GetMachineConfigurationResponses as FirecrackerGetMachineConfigurationResponses,
  GetMemoryHotplugData as FirecrackerGetMemoryHotplugData,
  GetMemoryHotplugError as FirecrackerGetMemoryHotplugError,
  GetMemoryHotplugErrors as FirecrackerGetMemoryHotplugErrors,
  GetMemoryHotplugResponse as FirecrackerGetMemoryHotplugResponse,
  GetMemoryHotplugResponses as FirecrackerGetMemoryHotplugResponses,
  GetMmdsData as FirecrackerGetMmdsData,
  GetMmdsError as FirecrackerGetMmdsError,
  GetMmdsErrors as FirecrackerGetMmdsErrors,
  GetMmdsResponse as FirecrackerGetMmdsResponse,
  GetMmdsResponses as FirecrackerGetMmdsResponses,
  InstanceActionInfo as FirecrackerInstanceActionInfo,
  InstanceInfo as FirecrackerInstanceInfo,
  LoadSnapshotData as FirecrackerLoadSnapshotData,
  LoadSnapshotError as FirecrackerLoadSnapshotError,
  LoadSnapshotErrors as FirecrackerLoadSnapshotErrors,
  LoadSnapshotResponses as FirecrackerLoadSnapshotResponses,
  Logger as FirecrackerLogger,
  MachineConfiguration as FirecrackerMachineConfiguration,
  MemoryBackend as FirecrackerMemoryBackend,
  MemoryHotplugConfig as FirecrackerMemoryHotplugConfig,
  MemoryHotplugSizeUpdate as FirecrackerMemoryHotplugSizeUpdate,
  MemoryHotplugStatus as FirecrackerMemoryHotplugStatus,
  Metrics as FirecrackerMetrics,
  MmdsConfig as FirecrackerMmdsConfig,
  MmdsContentsObject as FirecrackerMmdsContentsObject,
  MsrModifier as FirecrackerMsrModifier,
  NetworkInterface as FirecrackerNetworkInterface,
  NetworkOverride as FirecrackerNetworkOverride,
  PartialDrive as FirecrackerPartialDrive,
  PartialNetworkInterface as FirecrackerPartialNetworkInterface,
  PartialPmem as FirecrackerPartialPmem,
  PatchBalloonData as FirecrackerPatchBalloonData,
  PatchBalloonError as FirecrackerPatchBalloonError,
  PatchBalloonErrors as FirecrackerPatchBalloonErrors,
  PatchBalloonResponses as FirecrackerPatchBalloonResponses,
  PatchBalloonStatsIntervalData as FirecrackerPatchBalloonStatsIntervalData,
  PatchBalloonStatsIntervalError as FirecrackerPatchBalloonStatsIntervalError,
  PatchBalloonStatsIntervalErrors as FirecrackerPatchBalloonStatsIntervalErrors,
  PatchBalloonStatsIntervalResponses as FirecrackerPatchBalloonStatsIntervalResponses,
  PatchGuestDriveByIdData as FirecrackerPatchGuestDriveByIdData,
  PatchGuestDriveByIdError as FirecrackerPatchGuestDriveByIdError,
  PatchGuestDriveByIdErrors as FirecrackerPatchGuestDriveByIdErrors,
  PatchGuestDriveByIdResponses as FirecrackerPatchGuestDriveByIdResponses,
  PatchGuestNetworkInterfaceByIdData as FirecrackerPatchGuestNetworkInterfaceByIdData,
  PatchGuestNetworkInterfaceByIdError as FirecrackerPatchGuestNetworkInterfaceByIdError,
  PatchGuestNetworkInterfaceByIdErrors as FirecrackerPatchGuestNetworkInterfaceByIdErrors,
  PatchGuestNetworkInterfaceByIdResponses as FirecrackerPatchGuestNetworkInterfaceByIdResponses,
  PatchGuestPmemByIdData as FirecrackerPatchGuestPmemByIdData,
  PatchGuestPmemByIdError as FirecrackerPatchGuestPmemByIdError,
  PatchGuestPmemByIdErrors as FirecrackerPatchGuestPmemByIdErrors,
  PatchGuestPmemByIdResponses as FirecrackerPatchGuestPmemByIdResponses,
  PatchMachineConfigurationData as FirecrackerPatchMachineConfigurationData,
  PatchMachineConfigurationError as FirecrackerPatchMachineConfigurationError,
  PatchMachineConfigurationErrors as FirecrackerPatchMachineConfigurationErrors,
  PatchMachineConfigurationResponses as FirecrackerPatchMachineConfigurationResponses,
  PatchMemoryHotplugData as FirecrackerPatchMemoryHotplugData,
  PatchMemoryHotplugError as FirecrackerPatchMemoryHotplugError,
  PatchMemoryHotplugErrors as FirecrackerPatchMemoryHotplugErrors,
  PatchMemoryHotplugResponses as FirecrackerPatchMemoryHotplugResponses,
  PatchMmdsData as FirecrackerPatchMmdsData,
  PatchMmdsError as FirecrackerPatchMmdsError,
  PatchMmdsErrors as FirecrackerPatchMmdsErrors,
  PatchMmdsResponses as FirecrackerPatchMmdsResponses,
  PatchVmData as FirecrackerPatchVmData,
  PatchVmError as FirecrackerPatchVmError,
  PatchVmErrors as FirecrackerPatchVmErrors,
  PatchVmResponses as FirecrackerPatchVmResponses,
  Pmem as FirecrackerPmem,
  PutBalloonData as FirecrackerPutBalloonData,
  PutBalloonError as FirecrackerPutBalloonError,
  PutBalloonErrors as FirecrackerPutBalloonErrors,
  PutBalloonResponses as FirecrackerPutBalloonResponses,
  PutCpuConfigurationData as FirecrackerPutCpuConfigurationData,
  PutCpuConfigurationError as FirecrackerPutCpuConfigurationError,
  PutCpuConfigurationErrors as FirecrackerPutCpuConfigurationErrors,
  PutCpuConfigurationResponses as FirecrackerPutCpuConfigurationResponses,
  PutEntropyDeviceData as FirecrackerPutEntropyDeviceData,
  PutEntropyDeviceError as FirecrackerPutEntropyDeviceError,
  PutEntropyDeviceErrors as FirecrackerPutEntropyDeviceErrors,
  PutEntropyDeviceResponses as FirecrackerPutEntropyDeviceResponses,
  PutGuestBootSourceData as FirecrackerPutGuestBootSourceData,
  PutGuestBootSourceError as FirecrackerPutGuestBootSourceError,
  PutGuestBootSourceErrors as FirecrackerPutGuestBootSourceErrors,
  PutGuestBootSourceResponses as FirecrackerPutGuestBootSourceResponses,
  PutGuestDriveByIdData as FirecrackerPutGuestDriveByIdData,
  PutGuestDriveByIdError as FirecrackerPutGuestDriveByIdError,
  PutGuestDriveByIdErrors as FirecrackerPutGuestDriveByIdErrors,
  PutGuestDriveByIdResponses as FirecrackerPutGuestDriveByIdResponses,
  PutGuestNetworkInterfaceByIdData as FirecrackerPutGuestNetworkInterfaceByIdData,
  PutGuestNetworkInterfaceByIdError as FirecrackerPutGuestNetworkInterfaceByIdError,
  PutGuestNetworkInterfaceByIdErrors as FirecrackerPutGuestNetworkInterfaceByIdErrors,
  PutGuestNetworkInterfaceByIdResponses as FirecrackerPutGuestNetworkInterfaceByIdResponses,
  PutGuestPmemByIdData as FirecrackerPutGuestPmemByIdData,
  PutGuestPmemByIdError as FirecrackerPutGuestPmemByIdError,
  PutGuestPmemByIdErrors as FirecrackerPutGuestPmemByIdErrors,
  PutGuestPmemByIdResponses as FirecrackerPutGuestPmemByIdResponses,
  PutGuestVsockData as FirecrackerPutGuestVsockData,
  PutGuestVsockError as FirecrackerPutGuestVsockError,
  PutGuestVsockErrors as FirecrackerPutGuestVsockErrors,
  PutGuestVsockResponses as FirecrackerPutGuestVsockResponses,
  PutLoggerData as FirecrackerPutLoggerData,
  PutLoggerError as FirecrackerPutLoggerError,
  PutLoggerErrors as FirecrackerPutLoggerErrors,
  PutLoggerResponses as FirecrackerPutLoggerResponses,
  PutMachineConfigurationData as FirecrackerPutMachineConfigurationData,
  PutMachineConfigurationError as FirecrackerPutMachineConfigurationError,
  PutMachineConfigurationErrors as FirecrackerPutMachineConfigurationErrors,
  PutMachineConfigurationResponses as FirecrackerPutMachineConfigurationResponses,
  PutMemoryHotplugData as FirecrackerPutMemoryHotplugData,
  PutMemoryHotplugError as FirecrackerPutMemoryHotplugError,
  PutMemoryHotplugErrors as FirecrackerPutMemoryHotplugErrors,
  PutMemoryHotplugResponses as FirecrackerPutMemoryHotplugResponses,
  PutMetricsData as FirecrackerPutMetricsData,
  PutMetricsError as FirecrackerPutMetricsError,
  PutMetricsErrors as FirecrackerPutMetricsErrors,
  PutMetricsResponses as FirecrackerPutMetricsResponses,
  PutMmdsConfigData as FirecrackerPutMmdsConfigData,
  PutMmdsConfigError as FirecrackerPutMmdsConfigError,
  PutMmdsConfigErrors as FirecrackerPutMmdsConfigErrors,
  PutMmdsConfigResponses as FirecrackerPutMmdsConfigResponses,
  PutMmdsData as FirecrackerPutMmdsData,
  PutMmdsError as FirecrackerPutMmdsError,
  PutMmdsErrors as FirecrackerPutMmdsErrors,
  PutMmdsResponses as FirecrackerPutMmdsResponses,
  PutSerialDeviceData as FirecrackerPutSerialDeviceData,
  PutSerialDeviceError as FirecrackerPutSerialDeviceError,
  PutSerialDeviceErrors as FirecrackerPutSerialDeviceErrors,
  PutSerialDeviceResponses as FirecrackerPutSerialDeviceResponses,
  RateLimiter as FirecrackerRateLimiter,
  SerialDevice as FirecrackerSerialDevice,
  SnapshotCreateParams as FirecrackerSnapshotCreateParams,
  SnapshotLoadParams as FirecrackerSnapshotLoadParams,
  StartBalloonHintingData as FirecrackerStartBalloonHintingData,
  StartBalloonHintingError as FirecrackerStartBalloonHintingError,
  StartBalloonHintingErrors as FirecrackerStartBalloonHintingErrors,
  StartBalloonHintingResponses as FirecrackerStartBalloonHintingResponses,
  StopBalloonHintingData as FirecrackerStopBalloonHintingData,
  StopBalloonHintingError as FirecrackerStopBalloonHintingError,
  StopBalloonHintingErrors as FirecrackerStopBalloonHintingErrors,
  StopBalloonHintingResponses as FirecrackerStopBalloonHintingResponses,
  TokenBucket as FirecrackerTokenBucket,
  VcpuFeatures as FirecrackerVcpuFeatures,
  Vm as FirecrackerVm,
  Vsock as FirecrackerVsock,
  VsockOverride as FirecrackerVsockOverride,
} from "./firecracker/types.gen";

export class Firecracker {
  #agent: Agent;
  #client: ReturnType<typeof createClient>;

  constructor(socket: string) {
    this.#agent = new Agent({ socketPath: socket });
    this.#client = createClient(
      createConfig({
        baseUrl: "http://localhost",
        fetch: (input) => {
          // @ts-expect-error
          return fetch(input, { dispatcher: this.#agent }).then((resp) => {
            return resp;
          });
        },
      }),
    );
  }

  async createSnapshot(body: Firecracker.SnapshotCreateParams) {
    return createSnapshot({ throwOnError: true, client: this.#client, body });
  }

  async createSyncAction(body: Firecracker.InstanceActionInfo) {
    return createSyncAction({ throwOnError: true, client: this.#client, body });
  }

  async describeBalloonConfig() {}
  async describeBalloonHinting() {}
  async describeBalloonStats() {}
  async describeInstance() {}

  async getExportVmConfig() {
    return getExportVmConfig({ throwOnError: true, client: this.#client });
  }

  async getFirecrackerVersion() {}
  async getMachineConfiguration() {}
  async getMemoryHotplug() {}
  async getMmds() {}
  async loadSnapshot() {}
  async patchBalloon() {}
  async patchBalloonStatsInterval() {}
  async patchGuestDriveById(id: string, body: Firecracker.PartialDrive) {
    return patchGuestDriveById({ throwOnError: true, client: this.#client, body, path: { drive_id: id } });
  }

  async patchGuestNetworkInterfaceById() {}

  async patchGuestPmemById() {}
  async patchMachineConfiguration() {}
  async patchMemoryHotplug() {}
  async patchMmds() {}
  async patchVm() {}
  async putBalloon() {}
  async putCpuConfiguration() {}
  async putEntropyDevice() {}

  async putGuestBootSource(body: Firecracker.BootSource) {
    return putGuestBootSource({ throwOnError: true, client: this.#client, body });
  }

  async putGuestDriveById(id: string, body: Firecracker.Drive) {
    return putGuestDriveById({ throwOnError: true, client: this.#client, body, path: { drive_id: id } });
  }

  async putGuestNetworkInterfaceById(id: string, body: FirecrackerNetworkInterface) {
    return putGuestNetworkInterfaceById({ throwOnError: true, client: this.#client, body, path: { iface_id: id } });
  }

  async putGuestPmemById() {}

  async putGuestVsock(body: FirecrackerVsock) {
    return putGuestVsock({ throwOnError: true, client: this.#client, body });
  }

  async putLogger(body: Firecracker.Logger) {
    return putLogger({ throwOnError: true, client: this.#client, body });
  }

  async putMachineConfiguration(body: Firecracker.MachineConfiguration) {
    return putMachineConfiguration({ throwOnError: true, client: this.#client, body });
  }

  async putMemoryHotplug() {}
  async putMetrics() {}

  async putMmds(body: Firecracker.MmdsContentsObject) {
    return putMmds({ throwOnError: true, client: this.#client, body });
  }

  async putMmdsConfig(body: Firecracker.MmdsConfig) {
    return putMmdsConfig({ throwOnError: true, client: this.#client, body });
  }

  async putSerialDevice(body: Firecracker.SerialDevice) {
    return putSerialDevice({ throwOnError: true, client: this.#client, body });
  }

  async startBalloonHinting() {}
  async stopBalloonHinting() {}
}

export namespace Firecracker {
  export type ArmRegisterModifier = FirecrackerArmRegisterModifier;
  export type Balloon = FirecrackerBalloon;
  export type BalloonHintingStatus = FirecrackerBalloonHintingStatus;
  export type BalloonStartCmd = FirecrackerBalloonStartCmd;
  export type BalloonStats = FirecrackerBalloonStats;
  export type BalloonStatsUpdate = FirecrackerBalloonStatsUpdate;
  export type BalloonUpdate = FirecrackerBalloonUpdate;
  export type BootSource = FirecrackerBootSource;
  export type ClientOptions = FirecrackerClientOptions;
  export type CpuConfig = FirecrackerCpuConfig;
  export type CpuidLeafModifier = FirecrackerCpuidLeafModifier;
  export type CpuidRegisterModifier = FirecrackerCpuidRegisterModifier;
  export type CpuTemplate = FirecrackerCpuTemplate;
  export type CreateSnapshotData = FirecrackerCreateSnapshotData;
  export type CreateSnapshotError = FirecrackerCreateSnapshotError;
  export type CreateSnapshotErrors = FirecrackerCreateSnapshotErrors;
  export type CreateSnapshotResponses = FirecrackerCreateSnapshotResponses;
  export type CreateSyncActionData = FirecrackerCreateSyncActionData;
  export type CreateSyncActionError = FirecrackerCreateSyncActionError;
  export type CreateSyncActionErrors = FirecrackerCreateSyncActionErrors;
  export type CreateSyncActionResponses = FirecrackerCreateSyncActionResponses;
  export type DescribeBalloonConfigData = FirecrackerDescribeBalloonConfigData;
  export type DescribeBalloonConfigError = FirecrackerDescribeBalloonConfigError;
  export type DescribeBalloonConfigErrors = FirecrackerDescribeBalloonConfigErrors;
  export type DescribeBalloonConfigResponse = FirecrackerDescribeBalloonConfigResponse;
  export type DescribeBalloonConfigResponses = FirecrackerDescribeBalloonConfigResponses;
  export type DescribeBalloonHintingData = FirecrackerDescribeBalloonHintingData;
  export type DescribeBalloonHintingError = FirecrackerDescribeBalloonHintingError;
  export type DescribeBalloonHintingErrors = FirecrackerDescribeBalloonHintingErrors;
  export type DescribeBalloonHintingResponse = FirecrackerDescribeBalloonHintingResponse;
  export type DescribeBalloonHintingResponses = FirecrackerDescribeBalloonHintingResponses;
  export type DescribeBalloonStatsData = FirecrackerDescribeBalloonStatsData;
  export type DescribeBalloonStatsError = FirecrackerDescribeBalloonStatsError;
  export type DescribeBalloonStatsErrors = FirecrackerDescribeBalloonStatsErrors;
  export type DescribeBalloonStatsResponse = FirecrackerDescribeBalloonStatsResponse;
  export type DescribeBalloonStatsResponses = FirecrackerDescribeBalloonStatsResponses;
  export type DescribeInstanceData = FirecrackerDescribeInstanceData;
  export type DescribeInstanceError = FirecrackerDescribeInstanceError;
  export type DescribeInstanceErrors = FirecrackerDescribeInstanceErrors;
  export type DescribeInstanceResponse = FirecrackerDescribeInstanceResponse;
  export type DescribeInstanceResponses = FirecrackerDescribeInstanceResponses;
  export type Drive = FirecrackerDrive;
  export type EntropyDevice = FirecrackerEntropyDevice;
  export type Error = FirecrackerError;
  export type FirecrackerVersion = FirecrackerFirecrackerVersion;
  export type FullVmConfiguration = FirecrackerFullVmConfiguration;
  export type GetExportVmConfigData = FirecrackerGetExportVmConfigData;
  export type GetExportVmConfigError = FirecrackerGetExportVmConfigError;
  export type GetExportVmConfigErrors = FirecrackerGetExportVmConfigErrors;
  export type GetExportVmConfigResponse = FirecrackerGetExportVmConfigResponse;
  export type GetExportVmConfigResponses = FirecrackerGetExportVmConfigResponses;
  export type GetFirecrackerVersionData = FirecrackerGetFirecrackerVersionData;
  export type GetFirecrackerVersionError = FirecrackerGetFirecrackerVersionError;
  export type GetFirecrackerVersionErrors = FirecrackerGetFirecrackerVersionErrors;
  export type GetFirecrackerVersionResponse = FirecrackerGetFirecrackerVersionResponse;
  export type GetFirecrackerVersionResponses = FirecrackerGetFirecrackerVersionResponses;
  export type GetMachineConfigurationData = FirecrackerGetMachineConfigurationData;
  export type GetMachineConfigurationError = FirecrackerGetMachineConfigurationError;
  export type GetMachineConfigurationErrors = FirecrackerGetMachineConfigurationErrors;
  export type GetMachineConfigurationResponse = FirecrackerGetMachineConfigurationResponse;
  export type GetMachineConfigurationResponses = FirecrackerGetMachineConfigurationResponses;
  export type GetMemoryHotplugData = FirecrackerGetMemoryHotplugData;
  export type GetMemoryHotplugError = FirecrackerGetMemoryHotplugError;
  export type GetMemoryHotplugErrors = FirecrackerGetMemoryHotplugErrors;
  export type GetMemoryHotplugResponse = FirecrackerGetMemoryHotplugResponse;
  export type GetMemoryHotplugResponses = FirecrackerGetMemoryHotplugResponses;
  export type GetMmdsData = FirecrackerGetMmdsData;
  export type GetMmdsError = FirecrackerGetMmdsError;
  export type GetMmdsErrors = FirecrackerGetMmdsErrors;
  export type GetMmdsResponse = FirecrackerGetMmdsResponse;
  export type GetMmdsResponses = FirecrackerGetMmdsResponses;
  export type InstanceActionInfo = FirecrackerInstanceActionInfo;
  export type InstanceInfo = FirecrackerInstanceInfo;
  export type LoadSnapshotData = FirecrackerLoadSnapshotData;
  export type LoadSnapshotError = FirecrackerLoadSnapshotError;
  export type LoadSnapshotErrors = FirecrackerLoadSnapshotErrors;
  export type LoadSnapshotResponses = FirecrackerLoadSnapshotResponses;
  export type Logger = FirecrackerLogger;
  export type MachineConfiguration = FirecrackerMachineConfiguration;
  export type MemoryBackend = FirecrackerMemoryBackend;
  export type MemoryHotplugConfig = FirecrackerMemoryHotplugConfig;
  export type MemoryHotplugSizeUpdate = FirecrackerMemoryHotplugSizeUpdate;
  export type MemoryHotplugStatus = FirecrackerMemoryHotplugStatus;
  export type Metrics = FirecrackerMetrics;
  export type MmdsConfig = FirecrackerMmdsConfig;
  export type MmdsContentsObject = FirecrackerMmdsContentsObject;
  export type MsrModifier = FirecrackerMsrModifier;
  export type NetworkInterface = FirecrackerNetworkInterface;
  export type NetworkOverride = FirecrackerNetworkOverride;
  export type PartialDrive = FirecrackerPartialDrive;
  export type PartialNetworkInterface = FirecrackerPartialNetworkInterface;
  export type PartialPmem = FirecrackerPartialPmem;
  export type PatchBalloonData = FirecrackerPatchBalloonData;
  export type PatchBalloonError = FirecrackerPatchBalloonError;
  export type PatchBalloonErrors = FirecrackerPatchBalloonErrors;
  export type PatchBalloonResponses = FirecrackerPatchBalloonResponses;
  export type PatchBalloonStatsIntervalData = FirecrackerPatchBalloonStatsIntervalData;
  export type PatchBalloonStatsIntervalError = FirecrackerPatchBalloonStatsIntervalError;
  export type PatchBalloonStatsIntervalErrors = FirecrackerPatchBalloonStatsIntervalErrors;
  export type PatchBalloonStatsIntervalResponses = FirecrackerPatchBalloonStatsIntervalResponses;
  export type PatchGuestDriveByIdData = FirecrackerPatchGuestDriveByIdData;
  export type PatchGuestDriveByIdError = FirecrackerPatchGuestDriveByIdError;
  export type PatchGuestDriveByIdErrors = FirecrackerPatchGuestDriveByIdErrors;
  export type PatchGuestDriveByIdResponses = FirecrackerPatchGuestDriveByIdResponses;
  export type PatchGuestNetworkInterfaceByIdData = FirecrackerPatchGuestNetworkInterfaceByIdData;
  export type PatchGuestNetworkInterfaceByIdError = FirecrackerPatchGuestNetworkInterfaceByIdError;
  export type PatchGuestNetworkInterfaceByIdErrors = FirecrackerPatchGuestNetworkInterfaceByIdErrors;
  export type PatchGuestNetworkInterfaceByIdResponses = FirecrackerPatchGuestNetworkInterfaceByIdResponses;
  export type PatchGuestPmemByIdData = FirecrackerPatchGuestPmemByIdData;
  export type PatchGuestPmemByIdError = FirecrackerPatchGuestPmemByIdError;
  export type PatchGuestPmemByIdErrors = FirecrackerPatchGuestPmemByIdErrors;
  export type PatchGuestPmemByIdResponses = FirecrackerPatchGuestPmemByIdResponses;
  export type PatchMachineConfigurationData = FirecrackerPatchMachineConfigurationData;
  export type PatchMachineConfigurationError = FirecrackerPatchMachineConfigurationError;
  export type PatchMachineConfigurationErrors = FirecrackerPatchMachineConfigurationErrors;
  export type PatchMachineConfigurationResponses = FirecrackerPatchMachineConfigurationResponses;
  export type PatchMemoryHotplugData = FirecrackerPatchMemoryHotplugData;
  export type PatchMemoryHotplugError = FirecrackerPatchMemoryHotplugError;
  export type PatchMemoryHotplugErrors = FirecrackerPatchMemoryHotplugErrors;
  export type PatchMemoryHotplugResponses = FirecrackerPatchMemoryHotplugResponses;
  export type PatchMmdsData = FirecrackerPatchMmdsData;
  export type PatchMmdsError = FirecrackerPatchMmdsError;
  export type PatchMmdsErrors = FirecrackerPatchMmdsErrors;
  export type PatchMmdsResponses = FirecrackerPatchMmdsResponses;
  export type PatchVmData = FirecrackerPatchVmData;
  export type PatchVmError = FirecrackerPatchVmError;
  export type PatchVmErrors = FirecrackerPatchVmErrors;
  export type PatchVmResponses = FirecrackerPatchVmResponses;
  export type Pmem = FirecrackerPmem;
  export type PutBalloonData = FirecrackerPutBalloonData;
  export type PutBalloonError = FirecrackerPutBalloonError;
  export type PutBalloonErrors = FirecrackerPutBalloonErrors;
  export type PutBalloonResponses = FirecrackerPutBalloonResponses;
  export type PutCpuConfigurationData = FirecrackerPutCpuConfigurationData;
  export type PutCpuConfigurationError = FirecrackerPutCpuConfigurationError;
  export type PutCpuConfigurationErrors = FirecrackerPutCpuConfigurationErrors;
  export type PutCpuConfigurationResponses = FirecrackerPutCpuConfigurationResponses;
  export type PutEntropyDeviceData = FirecrackerPutEntropyDeviceData;
  export type PutEntropyDeviceError = FirecrackerPutEntropyDeviceError;
  export type PutEntropyDeviceErrors = FirecrackerPutEntropyDeviceErrors;
  export type PutEntropyDeviceResponses = FirecrackerPutEntropyDeviceResponses;
  export type PutGuestBootSourceData = FirecrackerPutGuestBootSourceData;
  export type PutGuestBootSourceError = FirecrackerPutGuestBootSourceError;
  export type PutGuestBootSourceErrors = FirecrackerPutGuestBootSourceErrors;
  export type PutGuestBootSourceResponses = FirecrackerPutGuestBootSourceResponses;
  export type PutGuestDriveByIdData = FirecrackerPutGuestDriveByIdData;
  export type PutGuestDriveByIdError = FirecrackerPutGuestDriveByIdError;
  export type PutGuestDriveByIdErrors = FirecrackerPutGuestDriveByIdErrors;
  export type PutGuestDriveByIdResponses = FirecrackerPutGuestDriveByIdResponses;
  export type PutGuestNetworkInterfaceByIdData = FirecrackerPutGuestNetworkInterfaceByIdData;
  export type PutGuestNetworkInterfaceByIdError = FirecrackerPutGuestNetworkInterfaceByIdError;
  export type PutGuestNetworkInterfaceByIdErrors = FirecrackerPutGuestNetworkInterfaceByIdErrors;
  export type PutGuestNetworkInterfaceByIdResponses = FirecrackerPutGuestNetworkInterfaceByIdResponses;
  export type PutGuestPmemByIdData = FirecrackerPutGuestPmemByIdData;
  export type PutGuestPmemByIdError = FirecrackerPutGuestPmemByIdError;
  export type PutGuestPmemByIdErrors = FirecrackerPutGuestPmemByIdErrors;
  export type PutGuestPmemByIdResponses = FirecrackerPutGuestPmemByIdResponses;
  export type PutGuestVsockData = FirecrackerPutGuestVsockData;
  export type PutGuestVsockError = FirecrackerPutGuestVsockError;
  export type PutGuestVsockErrors = FirecrackerPutGuestVsockErrors;
  export type PutGuestVsockResponses = FirecrackerPutGuestVsockResponses;
  export type PutLoggerData = FirecrackerPutLoggerData;
  export type PutLoggerError = FirecrackerPutLoggerError;
  export type PutLoggerErrors = FirecrackerPutLoggerErrors;
  export type PutLoggerResponses = FirecrackerPutLoggerResponses;
  export type PutMachineConfigurationData = FirecrackerPutMachineConfigurationData;
  export type PutMachineConfigurationError = FirecrackerPutMachineConfigurationError;
  export type PutMachineConfigurationErrors = FirecrackerPutMachineConfigurationErrors;
  export type PutMachineConfigurationResponses = FirecrackerPutMachineConfigurationResponses;
  export type PutMemoryHotplugData = FirecrackerPutMemoryHotplugData;
  export type PutMemoryHotplugError = FirecrackerPutMemoryHotplugError;
  export type PutMemoryHotplugErrors = FirecrackerPutMemoryHotplugErrors;
  export type PutMemoryHotplugResponses = FirecrackerPutMemoryHotplugResponses;
  export type PutMetricsData = FirecrackerPutMetricsData;
  export type PutMetricsError = FirecrackerPutMetricsError;
  export type PutMetricsErrors = FirecrackerPutMetricsErrors;
  export type PutMetricsResponses = FirecrackerPutMetricsResponses;
  export type PutMmdsConfigData = FirecrackerPutMmdsConfigData;
  export type PutMmdsConfigError = FirecrackerPutMmdsConfigError;
  export type PutMmdsConfigErrors = FirecrackerPutMmdsConfigErrors;
  export type PutMmdsConfigResponses = FirecrackerPutMmdsConfigResponses;
  export type PutMmdsData = FirecrackerPutMmdsData;
  export type PutMmdsError = FirecrackerPutMmdsError;
  export type PutMmdsErrors = FirecrackerPutMmdsErrors;
  export type PutMmdsResponses = FirecrackerPutMmdsResponses;
  export type PutSerialDeviceData = FirecrackerPutSerialDeviceData;
  export type PutSerialDeviceError = FirecrackerPutSerialDeviceError;
  export type PutSerialDeviceErrors = FirecrackerPutSerialDeviceErrors;
  export type PutSerialDeviceResponses = FirecrackerPutSerialDeviceResponses;
  export type RateLimiter = FirecrackerRateLimiter;
  export type SerialDevice = FirecrackerSerialDevice;
  export type SnapshotCreateParams = FirecrackerSnapshotCreateParams;
  export type SnapshotLoadParams = FirecrackerSnapshotLoadParams;
  export type StartBalloonHintingData = FirecrackerStartBalloonHintingData;
  export type StartBalloonHintingError = FirecrackerStartBalloonHintingError;
  export type StartBalloonHintingErrors = FirecrackerStartBalloonHintingErrors;
  export type StartBalloonHintingResponses = FirecrackerStartBalloonHintingResponses;
  export type StopBalloonHintingData = FirecrackerStopBalloonHintingData;
  export type StopBalloonHintingError = FirecrackerStopBalloonHintingError;
  export type StopBalloonHintingErrors = FirecrackerStopBalloonHintingErrors;
  export type StopBalloonHintingResponses = FirecrackerStopBalloonHintingResponses;
  export type TokenBucket = FirecrackerTokenBucket;
  export type VcpuFeatures = FirecrackerVcpuFeatures;
  export type Vm = FirecrackerVm;
  export type Vsock = FirecrackerVsock;
  export type VsockOverride = FirecrackerVsockOverride;
}
