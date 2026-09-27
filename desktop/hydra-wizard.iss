// Included after hydra-update-mode.iss at the start of the pinned [Code] section.
// Upstream's installer defines no InitializeWizard, so this is Hydra's own.
procedure InitializeWizard();
begin
  // With the modern wizard on Windows 11 at display scaling above 100%, Inno draws
  // the tasks page's checkboxes flush against the list's left edge and clips their
  // left side. A few pixels of offset draws them whole (checked at 150%).
  WizardForm.TasksList.Offset := ScaleX(4);
end;
