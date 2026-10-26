Pod::Spec.new do |s|
  s.name = 'AiraSpeechCapabilities'
  s.version = '1.0.0'
  s.summary = 'Locale-specific on-device speech capability for AIRA'
  s.description = 'Checks the exact wake phrase locale before microphone recognition starts.'
  s.license = { :type => 'MIT' }
  s.author = 'Air2o'
  s.homepage = 'https://air2o.com'
  s.platforms = { :ios => '15.1' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Speech'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift}'
end
