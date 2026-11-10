var e=[{_time:1653075181,cribl_breaker:`Break on newlines`,_raw:`05/21/2022 01:03:01 AM
LogName=Application
SourceName=FIMSynchronizationService
EventCode=6801
EventType=2
Type=Error
ComputerName=myhost.acme.com
TaskCategory=Server
OpCode=None
RecordNumber=4604215
Keywords=Classic
Message=The extensible extension returned an unsupported error.\r
 The stack trace is:\r
 \r
 "System.Reflection.TargetInvocationException: Exception has been thrown by the target of an invocation. ---> System.AggregateException: One or more errors occurred. ---> System.InvalidOperationException: More than one DN specified for the same profile.\r
   at Microsoft.Office.Server.UserProfiles.ProfileImportExportService.AddDNLookupTable(UserProfileApplicationProxy upaProxy, Guid partitionID, Int64 recordId, String objectType, String distinguishedName)\r
   at Microsoft.Office.Server.UserProfiles.ProfileImportExportService.<>c__DisplayClass26.<UpdateWithProfileChangeData>b__24(Int32 idx)\r
   at System.Threading.Tasks.Parallel.<>c__DisplayClass17_0\`1.<ForWorker>b__1()\r
   at System.Threading.Tasks.Task.InnerInvokeWithArg(Task childTask)\r
   at System.Threading.Tasks.Task.<>c__DisplayClass176_0.<ExecuteSelfReplicating>b__0(Object )\r
   --- End of inner exception stack trace ---\r
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)\r
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)\r
   at System.Threading.Tasks.Parallel.ForWorker[TLocal](Int32 fromInclusive, Int32 toExclusive, ParallelOptions parallelOptions, Action\`1 body, Action\`2 bodyWithState, Func\`4 bodyWithLocal, Func\`1 localInit, Action\`1 localFinally)\r
   at System.Threading.Tasks.Parallel.For(Int32 fromInclusive, Int32 toExclusive, ParallelOptions parallelOptions, Action\`1 body)\r
   at Microsoft.Office.Server.UserProfiles.ProfileImportExportService.UpdateWithProfileChangeData(Int64 importExportId, ProfileChangeData[] profileChangeData)\r
   --- End of inner exception stack trace ---\r
   at System.RuntimeMethodHandle.InvokeMethod(Object target, Object[] arguments, Signature sig, Boolean constructor)\r
   at System.Reflection.RuntimeMethodInfo.UnsafeInvokeInternal(Object obj, Object[] parameters, Object[] arguments)\r
   at System.Reflection.RuntimeMethodInfo.Invoke(Object obj, BindingFlags invokeAttr, Binder binder, Object[] parameters, CultureInfo culture)\r
   at Microsoft.Office.Server.WebServiceDirectProxy.WebMethodInfo.Invoke(Object webServiceInstance, Object[] args)\r
   at Microsoft.Office.Server.WebServiceDirectProxy.Invoke(String methodName, Object[] args)\r
   at Microsoft.Office.Server.UserProfiles.ManagementAgent.ProfileImportExportDirect.UpdateWithProfileChangeData(Int64 importExportId, ProfileChangeData[] profileChangeData)\r
   at Microsoft.Office.Server.UserProfiles.ManagementAgent.ProfileImportExportExtension.Microsoft.MetadirectoryServices.IMAExtensibleCallExport.ExportEntry(ModificationType modificationType, String[] changedAttributes, CSEntry csentry)\r
Forefront Identity Manager 4.0.2450.51"`}];export{e as default};